// Sync engine: keeps IndexedDB complete and current, and loads chats from it.
//
// Two guarantees hold everything together:
//
//  1. Catch-up. A cursor records the highest server ROWID we have ingested.
//     Every reconnect, tab focus and periodic sweep asks the server for all
//     messages past it, so nothing that arrives while we're away is missed —
//     including messages delivered late with an old timestamp.
//
//  2. Coverage. Each chat records `syncedFrom`: every message dated at or
//     after it is in IndexedDB. A chat therefore renders straight from local
//     data, and the network only ever adds to it.

import Dexie from 'dexie';
import { db, ContactRecord, MessageRecord } from '@/lib/db';
import { http } from './http';
import { socketService } from './socket';
import { beginHydration, endHydration, ingestChats, ingestMessages } from './ingest';
import { useSyncStore } from '@/stores/syncStore';
import { useChatStore } from '@/stores/chatStore';
import { useMessageStore } from '@/stores/messageStore';
import { useContactStore } from '@/stores/contactStore';

/** Messages per history page, and per tail refresh. */
export const PAGE_SIZE = 50;
/** Messages read into memory when a chat is opened. */
const HYDRATE_LIMIT = 80;

const CATCH_UP_BATCH = 200;
/** Past this many missed messages we stop replaying and re-seed chats on demand instead. */
const CATCH_UP_MAX = 4000;
const CHAT_PAGE_SIZE = 200;
/** How many of the most recent chats a routine refresh re-reads. */
const RECENT_CHATS = 50;
/** A chat's tail isn't re-fetched if it was fetched this recently. */
const TAIL_FRESH_MS = 15_000;
const SWEEP_INTERVAL_MS = 60_000;
const RESYNC_THROTTLE_MS = 5_000;
const PREWARM_CHATS = 20;

const CURSOR_KEY = 'rowCursor';
const CHATS_SYNCED_KEY = 'allChatsSynced';

const CATCH_UP_WITH = ['chats', 'attachments', 'attachment.metadata', 'attributedBody', 'messageSummaryInfo', 'payloadData'];

// ─── Catch-up ──────────────────────────────────────────

let catchUpInFlight: Promise<void> | null = null;

/** Ingest every message the server has stored since the cursor. Safe to call at any time. */
export function catchUp(): Promise<void> {
  if (catchUpInFlight) return catchUpInFlight;
  const run: Promise<void> = runCatchUp()
    .catch((err) => console.error('[Sync] Catch-up failed:', err))
    .finally(() => {
      if (catchUpInFlight === run) catchUpInFlight = null;
    });
  catchUpInFlight = run;
  return run;
}

async function runCatchUp() {
  const cursor = await db.getMeta<number>(CURSOR_KEY);
  if (cursor === undefined) {
    await establishCursor();
    return;
  }

  let maxRowId = cursor;
  let offset = 0;
  for (;;) {
    const res = await http.queryMessages({
      withQuery: CATCH_UP_WITH,
      where: [{ statement: 'message.ROWID > :rowId', args: { rowId: cursor } }],
      sort: 'ASC',
      offset,
      limit: CATCH_UP_BATCH,
    });
    const batch: any[] = res?.data ?? [];

    if (offset === 0 && (res?.metadata?.total ?? 0) > CATCH_UP_MAX) {
      console.warn(`[Sync] ${res.metadata.total} messages behind; re-seeding instead of replaying`);
      await resetCoverage();
      return;
    }

    if (batch.length > 0) {
      await ingestMessages(batch, { live: true });
      for (const msg of batch) maxRowId = Math.max(maxRowId, msg.originalROWID ?? 0);
    }
    if (batch.length < CATCH_UP_BATCH) break;
    offset += batch.length;
  }

  if (maxRowId > cursor) await db.setMeta(CURSOR_KEY, maxRowId);
  useSyncStore.getState().setLastIncrementalSync(Date.now());
}

/** Start the cursor at the newest message the server has, without ingesting history. */
async function establishCursor() {
  const res = await http.queryMessages({ withQuery: [], sort: 'DESC', limit: 25 });
  const newest: any[] = res?.data ?? [];
  const maxRowId = newest.reduce((max, msg) => Math.max(max, msg.originalROWID ?? 0), 0);
  await db.setMeta(CURSOR_KEY, maxRowId);
}

/** Forget what we believed was complete; every chat re-seeds the next time it is opened. */
async function resetCoverage() {
  await db.chats.toCollection().modify((chat) => {
    chat.syncedFrom = null;
    chat.historyComplete = false;
  });
  tailFetchedAt.clear();
  await establishCursor();

  const active = useChatStore.getState().activeChatGuid;
  useMessageStore.getState().clear();
  if (active) await openChat(active);
}

// ─── Chat list ─────────────────────────────────────────

let chatRefreshInFlight: Promise<void> | null = null;

/** Refresh the chat list from the server: the most recent page, or all of it. */
export function refreshChats(scope: 'recent' | 'all' = 'recent'): Promise<void> {
  if (scope === 'recent' && chatRefreshInFlight) return chatRefreshInFlight;

  const run = (async () => {
    const limit = scope === 'recent' ? RECENT_CHATS : CHAT_PAGE_SIZE;
    for (let offset = 0; ; offset += limit) {
      const res = await http.queryChats({
        withQuery: ['lastmessage', 'participants'],
        sort: 'lastmessage',
        offset,
        limit,
      });
      const chats: any[] = res?.data ?? [];
      await ingestChats(chats);
      if (scope === 'recent' || chats.length < limit) break;
    }
    if (scope === 'all') await db.setMeta(CHATS_SYNCED_KEY, Date.now());
  })()
    .catch((err) => console.error('[Sync] Chat refresh failed:', err))
    .finally(() => {
      if (chatRefreshInFlight === run) chatRefreshInFlight = null;
    });

  chatRefreshInFlight = run;
  return run;
}

// ─── Loading a chat ────────────────────────────────────

async function readLocalMessages(chatGuid: string, from: number | null, before: number | null, limit: number) {
  const lower = [chatGuid, from ?? Dexie.minKey];
  const upper = [chatGuid, before ?? Dexie.maxKey];
  const rows = await db.messages
    .where('[chatGuid+dateCreated]')
    .between(lower, upper, true, true)
    .reverse()
    .limit(limit)
    .toArray();
  return rows.reverse();
}

/** Read a chat's newest messages from IndexedDB into memory. */
async function hydrateChat(chatGuid: string) {
  beginHydration(chatGuid);
  try {
    const chat = await db.chats.get(chatGuid);
    const rows = await readLocalMessages(chatGuid, chat?.syncedFrom ?? null, null, HYDRATE_LIMIT);
    useMessageStore.getState().hydrate(chatGuid, rows, {
      historyComplete: !!chat?.historyComplete && rows.length < HYDRATE_LIMIT,
      activeChatGuid: useChatStore.getState().activeChatGuid,
    });
  } finally {
    endHydration(chatGuid);
  }
}

/**
 * Make a chat's messages available in memory. Resolves as soon as local data
 * is loaded; the server is consulted in the background and only adds to it.
 */
export async function openChat(chatGuid: string): Promise<void> {
  if (!useMessageStore.getState().slices[chatGuid]?.hydrated) {
    await hydrateChat(chatGuid);
  }
  void refreshTail(chatGuid);
}

const tailFetchedAt = new Map<string, number>();
const tailInFlight = new Map<string, Promise<void>>();

/**
 * Fetch a chat's newest page and fold it in. This seeds a chat we have never
 * loaded, picks up status changes (delivered, read, edited, unsent) on recent
 * messages, and proves the local copy is contiguous up to now.
 */
export function refreshTail(chatGuid: string, opts: { force?: boolean } = {}): Promise<void> {
  const inFlight = tailInFlight.get(chatGuid);
  if (inFlight) return inFlight;
  if (!opts.force && Date.now() - (tailFetchedAt.get(chatGuid) ?? 0) < TAIL_FRESH_MS) {
    return Promise.resolve();
  }

  const run: Promise<void> = runRefreshTail(chatGuid)
    .catch((err) => console.error(`[Sync] Tail refresh failed for ${chatGuid}:`, err))
    .finally(() => {
      if (tailInFlight.get(chatGuid) === run) tailInFlight.delete(chatGuid);
    });
  tailInFlight.set(chatGuid, run);
  return run;
}

async function runRefreshTail(chatGuid: string) {
  const res = await http.chatMessages(chatGuid, { limit: PAGE_SIZE });
  const raw: any[] = res?.data ?? [];
  const { messages, newGuids } = await ingestMessages(raw, { chatGuid, allowOlder: true });
  tailFetchedAt.set(chatGuid, Date.now());

  const chat = await db.chats.get(chatGuid);
  if (!chat) return;

  const pageIsFull = raw.length >= PAGE_SIZE;
  const pageOldest = messages.reduce((min, m) => Math.min(min, m.dateCreated), Infinity);
  const overlapsLocal = messages.some((m) => !newGuids.has(m.guid));

  let syncedFrom = chat.syncedFrom ?? null;
  let historyComplete = chat.historyComplete ?? false;
  let coverageShrank = false;

  if (messages.length === 0) {
    syncedFrom ??= 0;
    historyComplete = true;
  } else if (syncedFrom === null) {
    syncedFrom = pageOldest;
    historyComplete = !pageIsFull;
  } else if (!overlapsLocal && pageIsFull && pageOldest > syncedFrom) {
    // Nothing on the page was known locally, so messages may be missing
    // between what we had and this page. Trust only the page.
    syncedFrom = pageOldest;
    historyComplete = false;
    coverageShrank = true;
  } else {
    syncedFrom = Math.min(syncedFrom, pageOldest);
    if (!pageIsFull) historyComplete = true;
  }

  if (syncedFrom !== (chat.syncedFrom ?? null) || historyComplete !== (chat.historyComplete ?? false)) {
    await db.chats.update(chatGuid, { syncedFrom, historyComplete });
  }

  const slice = useMessageStore.getState().slices[chatGuid];
  if (!slice?.hydrated) return;
  // Memory may hold messages from before the range we can now vouch for
  const holdsUncovered = slice.messages.length > 0 && slice.messages[0].dateCreated < syncedFrom;
  if (coverageShrank || holdsUncovered) {
    await hydrateChat(chatGuid);
  } else if (historyComplete && messages.length < PAGE_SIZE && slice.messages.length < HYDRATE_LIMIT) {
    useMessageStore.getState().setHistoryComplete(chatGuid, true);
  }
}

const olderInFlight = new Map<string, Promise<void>>();

/** Load the page of messages before the oldest one in memory. */
export function loadOlder(chatGuid: string): Promise<void> {
  const inFlight = olderInFlight.get(chatGuid);
  if (inFlight) return inFlight;

  const slice = useMessageStore.getState().slices[chatGuid];
  if (!slice?.hydrated || slice.historyComplete || slice.messages.length === 0) return Promise.resolve();

  useMessageStore.getState().setLoadingOlder(chatGuid, true);
  const run: Promise<void> = runLoadOlder(chatGuid, slice.messages[0])
    .catch((err) => console.error(`[Sync] Loading older messages failed for ${chatGuid}:`, err))
    .finally(() => {
      if (olderInFlight.get(chatGuid) === run) olderInFlight.delete(chatGuid);
      useMessageStore.getState().setLoadingOlder(chatGuid, false);
    });
  olderInFlight.set(chatGuid, run);
  return run;
}

async function runLoadOlder(chatGuid: string, oldest: MessageRecord) {
  const store = useMessageStore.getState();
  const chat = await db.chats.get(chatGuid);
  const syncedFrom = chat?.syncedFrom ?? null;

  // Until the tail has been fetched we can't tell where local coverage starts
  if (syncedFrom === null) {
    await refreshTail(chatGuid, { force: true });
    return;
  }

  // Anything inside the covered range is already local. The read includes the
  // oldest message's own timestamp, so drop what memory already holds.
  if (syncedFrom < oldest.dateCreated) {
    const inMemory = new Set(store.slices[chatGuid]?.messages.map((m) => m.guid));
    const local = (await readLocalMessages(chatGuid, syncedFrom, oldest.dateCreated, PAGE_SIZE + 5)).filter(
      (m) => !inMemory.has(m.guid),
    );
    if (local.length > 0) {
      store.mergeMessages(chatGuid, local, { allowOlder: true });
      return;
    }
  }

  if (chat?.historyComplete) {
    store.setHistoryComplete(chatGuid, true);
    return;
  }

  // `before` is inclusive on the server, so the page repeats the oldest message
  const limit = PAGE_SIZE + 1;
  const res = await http.chatMessages(chatGuid, { before: oldest.dateCreated, limit });
  const raw: any[] = res?.data ?? [];
  const { messages } = await ingestMessages(raw, { chatGuid, allowOlder: true });

  const historyComplete = raw.length < limit;
  const pageOldest = messages.reduce((min, m) => Math.min(min, m.dateCreated), oldest.dateCreated);
  await db.chats.update(chatGuid, { syncedFrom: Math.min(syncedFrom, pageOldest), historyComplete });
  if (historyComplete) store.setHistoryComplete(chatGuid, true);
}

/** Seed the most recent chats in the background so opening them needs no network. */
async function prewarmChats() {
  const candidates = useChatStore
    .getState()
    .chats.slice(0, PREWARM_CHATS)
    .filter((chat) => chat.syncedFrom == null)
    .map((chat) => chat.guid);

  const worker = async () => {
    for (let guid = candidates.shift(); guid; guid = candidates.shift()) {
      await refreshTail(guid);
    }
  };
  await Promise.all([worker(), worker()]);
}

// ─── Lifecycle ─────────────────────────────────────────

let started = false;
let firstSync: Promise<void> | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let lastResyncAt = 0;

/** Bring everything up to date. Runs on reconnect, tab focus and coming back online. */
export async function resync(): Promise<void> {
  if (Date.now() - lastResyncAt < RESYNC_THROTTLE_MS) return;
  lastResyncAt = Date.now();

  const active = useChatStore.getState().activeChatGuid;
  await Promise.all([
    catchUp(),
    refreshChats('recent'),
    active ? refreshTail(active, { force: true }) : Promise.resolve(),
  ]);
}

function onConnect() {
  void resync();
}

function onVisible() {
  if (document.visibilityState !== 'visible') return;
  socketService.ensureConnected();
  void resync();
}

function onOnline() {
  socketService.ensureConnected();
  void resync();
}

/**
 * Start keeping the app in sync. Call once the HTTP service and socket are
 * configured; calling it again is a no-op.
 */
export function startSync(): Promise<void> {
  if (started || typeof window === 'undefined') return firstSync ?? Promise.resolve();
  started = true;

  socketService.on('connect', onConnect);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onOnline);
  // The sweep covers a socket that has gone quiet without disconnecting. It runs
  // in background tabs too, so unread state is right when the user looks over.
  sweepTimer = setInterval(() => void catchUp(), SWEEP_INTERVAL_MS);

  firstSync = resync();
  void (async () => {
    await firstSync;
    void prewarmChats();
    const allChatsSynced = await db.getMeta<number>(CHATS_SYNCED_KEY);
    if (!allChatsSynced) await refreshChats('all');
    await syncContacts();
    await useContactStore.getState().loadContacts();
  })();
  return firstSync;
}

/** Stop syncing and forget all in-memory sync state (sign-out). */
export function stopSync() {
  if (started) {
    socketService.off('connect', onConnect);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', onOnline);
  }
  started = false;
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  firstSync = null;
  lastResyncAt = 0;
  // Requests still in the air belong to the session being left
  catchUpInFlight = null;
  chatRefreshInFlight = null;
  tailInFlight.clear();
  olderInFlight.clear();
  tailFetchedAt.clear();
}

// ─── Contact Sync ──────────────────────────────────────

/**
 * Normalize a phone number to digits-only (strip +, spaces, dashes, parens)
 * so that "+1 (234) 567-8901" and "12345678901" match.
 */
function normalizePhone(phone: string): string {
  return phone.replace(/[^\d]/g, '');
}

/**
 * Sync contacts from the BlueBubbles server into IndexedDB.
 * Also links HandleRecords to contacts by matching phone/email addresses.
 *
 * Called during full sync and can be triggered manually for a refresh.
 */
export async function syncContacts() {
  try {
    console.log('[Sync] Starting contact sync...');
    const res = await http.getContacts();
    const serverContacts: any[] = res?.data ?? [];

    if (serverContacts.length === 0) {
      console.log('[Sync] No contacts returned from server');
      return;
    }

    // Convert server contacts to ContactRecords
    const contactRecords: ContactRecord[] = serverContacts.map((c: any) => {
      const phones: string[] = [];
      const emails: string[] = [];

      // Server may return phoneNumbers/emails as arrays of objects or strings
      if (c.phoneNumbers) {
        for (const p of c.phoneNumbers) {
          const addr = typeof p === 'string' ? p : p?.address ?? p?.value ?? '';
          if (addr) phones.push(addr);
        }
      }
      if (c.emails) {
        for (const e of c.emails) {
          const addr = typeof e === 'string' ? e : e?.address ?? e?.value ?? '';
          if (addr) emails.push(addr);
        }
      }

      // Build display name from structured name or use server-provided displayName
      let displayName = c.displayName ?? '';
      if (!displayName && c.firstName) {
        displayName = [c.firstName, c.lastName].filter(Boolean).join(' ');
      }

      return {
        id: c.id ?? c.sourceId ?? `contact-${phones[0] ?? emails[0] ?? Math.random()}`,
        displayName: displayName || 'Unknown',
        phones,
        emails,
        structuredName: c.structuredName ?? c.name ?? null,
        avatarHash: c.avatar ? String(c.avatar).slice(0, 16) : null,
      };
    });

    // Bulk-upsert contacts
    await db.contacts.bulkPut(contactRecords);
    console.log(`[Sync] Stored ${contactRecords.length} contacts`);

    // Build a lookup: normalized address → contact ID
    const addressToContactId = new Map<string, string>();
    for (const contact of contactRecords) {
      for (const phone of contact.phones) {
        addressToContactId.set(normalizePhone(phone), contact.id);
        // Also store the original (for email-style matches)
        addressToContactId.set(phone.toLowerCase(), contact.id);
      }
      for (const email of contact.emails) {
        addressToContactId.set(email.toLowerCase(), contact.id);
      }
    }

    // Link handles to contacts
    const allHandles = await db.handles.toArray();
    let linked = 0;
    for (const handle of allHandles) {
      const normalizedAddr = normalizePhone(handle.address);
      const contactId =
        addressToContactId.get(handle.address.toLowerCase()) ??
        addressToContactId.get(normalizedAddr) ??
        null;

      if (contactId && contactId !== handle.contactId) {
        await db.handles.update(handle.address, { contactId });
        linked++;
      }
    }

    console.log(`[Sync] Linked ${linked} handles to contacts`);
  } catch (err) {
    console.error('[Sync] Contact sync failed:', err);
  }
}

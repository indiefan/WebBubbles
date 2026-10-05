// The one path by which server data enters the app.
//
// Socket events, catch-up sync, history pages and send responses all come
// through here, so IndexedDB and the in-memory stores can't drift apart and a
// message is always written together with its attachments, chat and sender.

import { db, ChatRecord, HandleRecord, MessageRecord } from '@/lib/db';
import { useChatStore } from '@/stores/chatStore';
import { useMessageStore } from '@/stores/messageStore';
import { http } from './http';
import {
  compareMessages,
  mergeChatRecord,
  mergeMessageRecord,
  previewText,
  serverChatToRecord,
  serverHandleToRecord,
  serverMessageToRecord,
} from './records';

export interface IngestOptions {
  /** The chat these payloads were fetched for, when they don't name one. */
  chatGuid?: string;
  /** The messages just arrived (socket, catch-up) rather than being history. */
  live?: boolean;
  /** Let messages older than what a chat has in memory through (history pages). */
  allowOlder?: boolean;
}

export interface IngestResult {
  /** The stored form of every message in the batch. */
  messages: MessageRecord[];
  /** Guids that were not in IndexedDB before this batch. */
  newGuids: Set<string>;
}

// Chats being read from IndexedDB into memory. Messages that arrive mid-read
// are parked here and applied once the read lands, so they can't be lost
// between the read's snapshot and the store update.
const hydrating = new Map<string, { msgs: MessageRecord[]; allowOlder: boolean }>();

export function beginHydration(chatGuid: string) {
  if (!hydrating.has(chatGuid)) hydrating.set(chatGuid, { msgs: [], allowOlder: false });
}

export function endHydration(chatGuid: string) {
  const parked = hydrating.get(chatGuid);
  hydrating.delete(chatGuid);
  if (parked && parked.msgs.length > 0) {
    useMessageStore.getState().mergeMessages(chatGuid, parked.msgs, { allowOlder: parked.allowOlder });
  }
}

function deliverToStore(chatGuid: string, msgs: MessageRecord[], allowOlder: boolean) {
  const parked = hydrating.get(chatGuid);
  if (parked) {
    parked.msgs.push(...msgs);
    parked.allowOlder ||= allowOlder;
    return;
  }
  useMessageStore.getState().mergeMessages(chatGuid, msgs, allowOlder ? { allowOlder } : undefined);
}

/** A regular message from someone else, as opposed to a group event or our own. */
function countsAsUnread(msg: MessageRecord): boolean {
  return !msg.isFromMe && !msg.dateRead && !msg.itemType;
}

function isOnScreen(chatGuid: string): boolean {
  if (useChatStore.getState().activeChatGuid !== chatGuid) return false;
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

async function addMissingHandles(handles: Map<string, HandleRecord>) {
  if (handles.size === 0) return;
  const addresses = [...handles.keys()];
  const have = await db.handles.bulkGet(addresses);
  const missing = addresses.filter((_, i) => !have[i]).map((a) => handles.get(a)!);
  // Existing handles are left alone: they may carry a contact link from contact sync
  if (missing.length > 0) await db.handles.bulkPut(missing);
}

export async function ingestMessages(rawMessages: any[], opts: IngestOptions = {}): Promise<IngestResult> {
  // Last payload wins when a guid appears twice in one batch
  const byGuid = new Map<string, { raw: any; record: MessageRecord }>();
  for (const raw of rawMessages) {
    if (!raw?.guid) continue;
    const record = serverMessageToRecord(raw, opts.chatGuid);
    if (!record.chatGuid) continue;
    if (raw.tempGuid) record.tempGuid = raw.tempGuid;
    byGuid.set(record.guid, { raw, record });
  }
  const incoming = [...byGuid.values()];
  const newGuids = new Set<string>();
  if (incoming.length === 0) return { messages: [], newGuids };

  let merged: MessageRecord[] = [];
  const changedChats: ChatRecord[] = [];
  const unknownChats: string[] = [];

  await db.transaction('rw', db.messages, db.chats, db.handles, async () => {
    const existing = await db.messages.bulkGet(incoming.map((i) => i.record.guid));
    merged = incoming.map((item, i) => {
      if (!existing[i]) newGuids.add(item.record.guid);
      return mergeMessageRecord(existing[i], item.record);
    });
    await db.messages.bulkPut(merged);

    const handles = new Map<string, HandleRecord>();
    for (const { raw } of incoming) {
      if (raw.handle?.address) handles.set(raw.handle.address, serverHandleToRecord(raw.handle));
    }
    await addMissingHandles(handles);

    // Bring each touched chat's preview and unread state up to date
    const byChat = new Map<string, MessageRecord[]>();
    for (const msg of merged) {
      const list = byChat.get(msg.chatGuid);
      if (list) list.push(msg);
      else byChat.set(msg.chatGuid, [msg]);
    }
    const chatGuids = [...byChat.keys()];
    const chats = await db.chats.bulkGet(chatGuids);

    chatGuids.forEach((chatGuid, i) => {
      const msgs = byChat.get(chatGuid)!;
      const stored = chats[i];
      let chat = stored;
      if (!chat) {
        const rawChat = incoming.find((item) => item.raw.chats?.[0]?.guid === chatGuid)?.raw.chats[0];
        chat = serverChatToRecord(rawChat ?? { guid: chatGuid });
        unknownChats.push(chatGuid);
      }

      const updates: Partial<ChatRecord> = {};
      const newest = msgs.reduce((a, b) => (compareMessages(a, b) >= 0 ? a : b));
      const preview = previewText(newest);
      if (
        newest.dateCreated >= (chat.lastMessageDate ?? 0) &&
        (chat.lastMessageGuid !== newest.guid || chat.lastMessageText !== preview)
      ) {
        updates.lastMessageGuid = newest.guid;
        updates.lastMessageDate = newest.dateCreated;
        updates.lastMessageText = preview;
      }

      // Unread means "arrived since this device last showed the chat". The
      // server's read flags only reflect the Mac itself, so they can clear a
      // dot but never set one.
      const isNewestInChat = newest.dateCreated >= (chat.lastMessageDate ?? 0);
      if (chat.hasUnreadMessage) {
        // Answered or read on another device
        if (isNewestInChat && (newest.isFromMe || newest.dateRead)) updates.hasUnreadMessage = false;
      } else if (opts.live && !isOnScreen(chatGuid) && isNewestInChat && countsAsUnread(newest)) {
        if (newGuids.has(newest.guid) && newest.dateCreated > (chat.lastReadAt ?? 0)) {
          updates.hasUnreadMessage = true;
        }
      }

      if (!stored || Object.keys(updates).length > 0) {
        changedChats.push({ ...chat, ...updates });
      }
    });

    if (changedChats.length > 0) await db.chats.bulkPut(changedChats);
  });

  // Stores are updated only after the write has committed
  const byChat = new Map<string, MessageRecord[]>();
  for (const msg of merged) {
    const list = byChat.get(msg.chatGuid);
    if (list) list.push(msg);
    else byChat.set(msg.chatGuid, [msg]);
  }
  for (const [chatGuid, msgs] of byChat) {
    deliverToStore(chatGuid, msgs, opts.allowOlder ?? false);
  }
  if (changedChats.length > 0) useChatStore.getState().upsertChats(changedChats);

  // A chat we've never seen arrives with no participants: fetch the rest
  for (const chatGuid of unknownChats) {
    void refreshChat(chatGuid);
  }

  return { messages: merged, newGuids };
}

/** Store chats from a server payload, keeping local-only state on ones we already have. */
export async function ingestChats(rawChats: any[]): Promise<ChatRecord[]> {
  const incoming = rawChats.filter((c) => c?.guid).map((raw) => ({ raw, record: serverChatToRecord(raw) }));
  if (incoming.length === 0) return [];

  let merged: ChatRecord[] = [];
  await db.transaction('rw', db.chats, db.handles, async () => {
    const existing = await db.chats.bulkGet(incoming.map((i) => i.record.guid));
    merged = incoming.map((item, i) => mergeChatRecord(existing[i], item.record, item.raw));
    await db.chats.bulkPut(merged);

    const handles = new Map<string, HandleRecord>();
    for (const { raw } of incoming) {
      for (const participant of raw.participants ?? []) {
        if (participant?.address) handles.set(participant.address, serverHandleToRecord(participant));
      }
    }
    await addMissingHandles(handles);
  });

  useChatStore.getState().upsertChats(merged);
  return merged;
}

const chatRefreshes = new Map<string, Promise<void>>();

/** Fetch one chat's full details (participants, last message) from the server. */
export function refreshChat(chatGuid: string): Promise<void> {
  const inFlight = chatRefreshes.get(chatGuid);
  if (inFlight) return inFlight;

  const run = (async () => {
    try {
      const res = await http.singleChat(chatGuid, 'participants,lastmessage');
      if (res?.data) await ingestChats([res.data]);
    } catch (err) {
      console.error(`[Ingest] Failed to refresh chat ${chatGuid}:`, err);
    } finally {
      chatRefreshes.delete(chatGuid);
    }
  })();
  chatRefreshes.set(chatGuid, run);
  return run;
}

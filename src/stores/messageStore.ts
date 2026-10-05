import { create } from 'zustand';
import { MessageRecord } from '@/lib/db';
import { compareMessages, sameRenderedMessage } from '@/services/records';

// Keep at most this many chats' messages in memory.
// Evicted chats are re-read from IndexedDB on the next visit.
export const MAX_CACHED_CHATS = 12;

// A chat that isn't on screen keeps only its newest messages in memory
export const INACTIVE_SLICE_LIMIT = 120;

export interface ChatMessageSlice {
  /** Confirmed messages, oldest first. Always one contiguous run ending at "now". */
  messages: MessageRecord[];
  /** Optimistic outgoing messages that the server hasn't confirmed, in send order. */
  pending: MessageRecord[];
  /** False while the chat only holds optimistic messages and hasn't been read from IndexedDB. */
  hydrated: boolean;
  /** True once paging has reached the start of the chat. */
  historyComplete: boolean;
  loadingOlder: boolean;
  lastAccessed: number;
}

/** Stable empty list so selectors don't hand React a new array on every call. */
export const NO_MESSAGES: MessageRecord[] = [];

interface MessageState {
  slices: Record<string, ChatMessageSlice>;
  replyToMessage: MessageRecord | null;

  /** Load a chat's messages into memory (replaces confirmed messages, keeps pending ones). */
  hydrate: (chatGuid: string, msgs: MessageRecord[], opts?: { historyComplete?: boolean; activeChatGuid?: string | null }) => void;
  /**
   * Fold messages into a chat that is already in memory. Unknown chats are
   * ignored: their messages live in IndexedDB until the chat is opened.
   *
   * Messages older than everything loaded are skipped unless `allowOlder` is
   * set, so the in-memory run stays contiguous.
   */
  mergeMessages: (chatGuid: string, msgs: MessageRecord[], opts?: { allowOlder?: boolean }) => void;
  /** Patch one message in place (optimistic edit / unsend, send failure). */
  updateMessage: (chatGuid: string, guid: string, updates: Partial<MessageRecord>) => void;

  addPending: (chatGuid: string, msg: MessageRecord) => void;
  /** Drop an optimistic message, optionally swapping in the confirmed one. */
  resolvePending: (chatGuid: string, tempGuid: string, confirmed?: MessageRecord) => void;

  setLoadingOlder: (chatGuid: string, loadingOlder: boolean) => void;
  setHistoryComplete: (chatGuid: string, historyComplete: boolean) => void;
  /** Shrink a chat that is no longer on screen to its newest messages. */
  trim: (chatGuid: string) => void;
  clearChat: (chatGuid: string) => void;

  setReplyToMessage: (msg: MessageRecord | null) => void;
  clearReplyToMessage: () => void;
  clear: () => void;
}

function emptySlice(): ChatMessageSlice {
  return {
    messages: [],
    pending: [],
    hydrated: false,
    historyComplete: false,
    loadingOlder: false,
    lastAccessed: Date.now(),
  };
}

/** Evict the least-recently-used chats, never the one on screen. */
function evictIfNeeded(
  slices: Record<string, ChatMessageSlice>,
  activeChatGuid: string | null | undefined,
): Record<string, ChatMessageSlice> {
  const keys = Object.keys(slices);
  if (keys.length <= MAX_CACHED_CHATS) return slices;

  const evictable = keys
    .filter((key) => key !== activeChatGuid && slices[key].pending.length === 0)
    .sort((a, b) => slices[a].lastAccessed - slices[b].lastAccessed);

  const next = { ...slices };
  for (const key of evictable.slice(0, keys.length - MAX_CACHED_CHATS)) {
    delete next[key];
  }
  return next;
}

/**
 * Merge `incoming` into the sorted list `current`. Objects whose rendered
 * content is unchanged keep their identity so memoized bubbles don't re-render;
 * returns `current` itself when nothing changed at all.
 */
export function mergeSorted(
  current: MessageRecord[],
  incoming: MessageRecord[],
  allowOlder: boolean,
): MessageRecord[] {
  if (incoming.length === 0) return current;

  const indexByGuid = new Map<string, number>();
  for (let i = 0; i < current.length; i++) indexByGuid.set(current[i].guid, i);

  const oldest = current.length > 0 ? current[0] : null;
  let next: MessageRecord[] | null = null;
  const added: MessageRecord[] = [];
  const addedGuids = new Set<string>();

  for (const msg of incoming) {
    if (addedGuids.has(msg.guid)) continue;
    const idx = indexByGuid.get(msg.guid);
    if (idx !== undefined) {
      const prev = (next ?? current)[idx];
      // A confirmed message keeps the key of the optimistic one it replaced
      const candidate = prev.tempGuid && !msg.tempGuid ? { ...msg, tempGuid: prev.tempGuid } : msg;
      if (!sameRenderedMessage(prev, candidate)) {
        next ??= [...current];
        next[idx] = candidate;
      }
    } else if (allowOlder || !oldest || compareMessages(msg, oldest) > 0) {
      added.push(msg);
      addedGuids.add(msg.guid);
    }
  }

  if (added.length === 0) return next ?? current;

  const result = next ?? [...current];
  added.sort(compareMessages);
  // Fast path: everything new belongs at the end
  if (result.length === 0 || compareMessages(added[0], result[result.length - 1]) > 0) {
    result.push(...added);
    return result;
  }
  result.push(...added);
  result.sort(compareMessages);
  return result;
}

export const useMessageStore = create<MessageState>((set) => ({
  slices: {},
  replyToMessage: null,

  hydrate: (chatGuid, msgs, opts) =>
    set((s) => {
      const prev = s.slices[chatGuid];
      const messages = mergeSorted(NO_MESSAGES, msgs, true);
      const confirmed = new Set(messages.map((m) => m.guid));
      const slice: ChatMessageSlice = {
        ...(prev ?? emptySlice()),
        messages,
        pending: (prev?.pending ?? []).filter((p) => !confirmed.has(p.guid)),
        hydrated: true,
        historyComplete: opts?.historyComplete ?? false,
        loadingOlder: false,
        lastAccessed: Date.now(),
      };
      return { slices: evictIfNeeded({ ...s.slices, [chatGuid]: slice }, opts?.activeChatGuid ?? chatGuid) };
    }),

  mergeMessages: (chatGuid, msgs, opts) =>
    set((s) => {
      const slice = s.slices[chatGuid];
      if (!slice?.hydrated) return s;

      const messages = mergeSorted(slice.messages, msgs, opts?.allowOlder ?? slice.historyComplete);

      // A confirmed message supersedes the optimistic copy it was sent as
      const confirmedTemps = new Set(msgs.map((m) => m.tempGuid).filter(Boolean));
      const pending =
        confirmedTemps.size > 0 ? slice.pending.filter((p) => !confirmedTemps.has(p.guid)) : slice.pending;

      if (messages === slice.messages && pending === slice.pending) return s;
      return { slices: { ...s.slices, [chatGuid]: { ...slice, messages, pending } } };
    }),

  updateMessage: (chatGuid, guid, updates) =>
    set((s) => {
      const slice = s.slices[chatGuid];
      if (!slice) return s;
      const patch = (list: MessageRecord[]) => {
        const idx = list.findIndex((m) => m.guid === guid);
        if (idx < 0) return list;
        const next = [...list];
        next[idx] = { ...next[idx], ...updates };
        return next;
      };
      const messages = patch(slice.messages);
      const pending = patch(slice.pending);
      if (messages === slice.messages && pending === slice.pending) return s;
      return { slices: { ...s.slices, [chatGuid]: { ...slice, messages, pending } } };
    }),

  addPending: (chatGuid, msg) =>
    set((s) => {
      const slice = s.slices[chatGuid] ?? emptySlice();
      if (slice.pending.some((p) => p.guid === msg.guid)) return s;
      return {
        slices: {
          ...s.slices,
          [chatGuid]: { ...slice, pending: [...slice.pending, msg], lastAccessed: Date.now() },
        },
      };
    }),

  resolvePending: (chatGuid, tempGuid, confirmed) =>
    set((s) => {
      const slice = s.slices[chatGuid];
      if (!slice) return s;
      const pending = slice.pending.filter((p) => p.guid !== tempGuid);
      const messages = confirmed
        ? mergeSorted(slice.messages, [{ ...confirmed, tempGuid }], true)
        : slice.messages;
      if (messages === slice.messages && pending.length === slice.pending.length) return s;
      return { slices: { ...s.slices, [chatGuid]: { ...slice, messages, pending } } };
    }),

  setLoadingOlder: (chatGuid, loadingOlder) =>
    set((s) => {
      const slice = s.slices[chatGuid];
      if (!slice || slice.loadingOlder === loadingOlder) return s;
      return { slices: { ...s.slices, [chatGuid]: { ...slice, loadingOlder } } };
    }),

  setHistoryComplete: (chatGuid, historyComplete) =>
    set((s) => {
      const slice = s.slices[chatGuid];
      if (!slice || slice.historyComplete === historyComplete) return s;
      return { slices: { ...s.slices, [chatGuid]: { ...slice, historyComplete } } };
    }),

  trim: (chatGuid) =>
    set((s) => {
      const slice = s.slices[chatGuid];
      if (!slice || slice.messages.length <= INACTIVE_SLICE_LIMIT) return s;
      return {
        slices: {
          ...s.slices,
          [chatGuid]: {
            ...slice,
            messages: slice.messages.slice(-INACTIVE_SLICE_LIMIT),
            historyComplete: false,
          },
        },
      };
    }),

  clearChat: (chatGuid) =>
    set((s) => {
      const next = { ...s.slices };
      delete next[chatGuid];
      return { slices: next };
    }),

  setReplyToMessage: (msg) => set({ replyToMessage: msg }),
  clearReplyToMessage: () => set({ replyToMessage: null }),
  clear: () => set({ slices: {}, replyToMessage: null }),
}));

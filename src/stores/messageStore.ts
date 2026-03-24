import { create } from 'zustand';
import { MessageRecord } from '@/lib/db';

// LRU eviction: keep at most this many chat slices in memory.
// Evicted chats will be re-fetched from IndexedDB on next visit.
export const MAX_CACHED_CHATS = 10;

export interface ChatMessageSlice {
  messages: MessageRecord[];
  loading: boolean;
  hasMore: boolean;
  lastAccessed: number;
}

function emptySlice(): ChatMessageSlice {
  return { messages: [], loading: false, hasMore: true, lastAccessed: Date.now() };
}

function touchSlice(slice: ChatMessageSlice): ChatMessageSlice {
  return { ...slice, lastAccessed: Date.now() };
}

/** Evict the least-recently-accessed slice that is NOT the active chat. */
function evictIfNeeded(
  slices: Record<string, ChatMessageSlice>,
  activeChatGuid: string | null,
): Record<string, ChatMessageSlice> {
  const keys = Object.keys(slices);
  if (keys.length <= MAX_CACHED_CHATS) return slices;

  let oldestKey: string | null = null;
  let oldestTime = Infinity;

  for (const key of keys) {
    if (key === activeChatGuid) continue; // never evict active chat
    if (slices[key].lastAccessed < oldestTime) {
      oldestTime = slices[key].lastAccessed;
      oldestKey = key;
    }
  }

  if (!oldestKey) return slices; // all slices are the active chat (shouldn't happen)

  const next = { ...slices };
  delete next[oldestKey];
  return next;
}

interface MessageState {
  slices: Record<string, ChatMessageSlice>;
  replyToMessage: MessageRecord | null;

  setMessages: (chatGuid: string, msgs: MessageRecord[]) => void;
  prependMessages: (chatGuid: string, msgs: MessageRecord[]) => void;
  addMessage: (chatGuid: string, msg: MessageRecord) => void;
  updateMessage: (chatGuid: string, guid: string, updates: Partial<MessageRecord>) => void;
  replaceTempGuid: (chatGuid: string, tempGuid: string, realGuid: string, updates: Partial<MessageRecord>) => void;
  setLoading: (chatGuid: string, loading: boolean) => void;
  setHasMore: (chatGuid: string, hasMore: boolean) => void;
  clearChat: (chatGuid: string) => void;

  setReplyToMessage: (msg: MessageRecord | null) => void;
  clearReplyToMessage: () => void;
  clear: () => void;
}

export const useMessageStore = create<MessageState>((set, get) => ({
  slices: {},
  replyToMessage: null,

  setMessages: (chatGuid, msgs) =>
    set((s) => {
      const slice = touchSlice(s.slices[chatGuid] ?? emptySlice());
      const newSlices = { ...s.slices, [chatGuid]: { ...slice, messages: msgs } };
      return { slices: evictIfNeeded(newSlices, null) };
    }),

  prependMessages: (chatGuid, msgs) =>
    set((s) => {
      const slice = touchSlice(s.slices[chatGuid] ?? emptySlice());
      const newSlices = {
        ...s.slices,
        [chatGuid]: { ...slice, messages: [...msgs, ...slice.messages] },
      };
      return { slices: evictIfNeeded(newSlices, null) };
    }),

  addMessage: (chatGuid, msg) =>
    set((s) => {
      const slice = touchSlice(s.slices[chatGuid] ?? emptySlice());
      // Deduplicate
      if (slice.messages.some((m) => m.guid === msg.guid)) {
        return { slices: { ...s.slices, [chatGuid]: slice } };
      }
      const newSlices = {
        ...s.slices,
        [chatGuid]: { ...slice, messages: [...slice.messages, msg] },
      };
      return { slices: evictIfNeeded(newSlices, null) };
    }),

  updateMessage: (chatGuid, guid, updates) =>
    set((s) => {
      const slice = s.slices[chatGuid];
      if (!slice) return s;
      return {
        slices: {
          ...s.slices,
          [chatGuid]: {
            ...touchSlice(slice),
            messages: slice.messages.map((m) => (m.guid === guid ? { ...m, ...updates } : m)),
          },
        },
      };
    }),

  replaceTempGuid: (chatGuid, tempGuid, realGuid, updates) =>
    set((s) => {
      const slice = s.slices[chatGuid];
      if (!slice) return s;
      return {
        slices: {
          ...s.slices,
          [chatGuid]: {
            ...touchSlice(slice),
            messages: slice.messages.map((m) =>
              m.guid === tempGuid ? { ...m, ...updates, guid: realGuid } : m,
            ),
          },
        },
      };
    }),

  setLoading: (chatGuid, loading) =>
    set((s) => {
      const slice = s.slices[chatGuid] ?? emptySlice();
      return { slices: { ...s.slices, [chatGuid]: { ...slice, loading } } };
    }),

  setHasMore: (chatGuid, hasMore) =>
    set((s) => {
      const slice = s.slices[chatGuid] ?? emptySlice();
      return { slices: { ...s.slices, [chatGuid]: { ...slice, hasMore } } };
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

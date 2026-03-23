import { create } from 'zustand';
import { MessageRecord } from '@/lib/db';

interface MessageState {
  messages: MessageRecord[];
  loading: boolean;
  hasMore: boolean;
  replyToMessage: MessageRecord | null;

  setMessages: (msgs: MessageRecord[]) => void;
  prependMessages: (msgs: MessageRecord[]) => void;
  addMessage: (msg: MessageRecord) => void;
  updateMessage: (guid: string, updates: Partial<MessageRecord>) => void;
  replaceTempGuid: (tempGuid: string, realGuid: string, updates: Partial<MessageRecord>) => void;
  setLoading: (loading: boolean) => void;
  setHasMore: (hasMore: boolean) => void;
  setReplyToMessage: (msg: MessageRecord | null) => void;
  clearReplyToMessage: () => void;
  clear: () => void;
}

export const useMessageStore = create<MessageState>((set) => ({
  messages: [],
  loading: false,
  hasMore: true,
  replyToMessage: null,

  setMessages: (messages) => set({ messages }),

  prependMessages: (msgs) =>
    set((s) => ({ messages: [...msgs, ...s.messages] })),

  addMessage: (msg) =>
    set((s) => {
      // Check for duplicates
      if (s.messages.some((m) => m.guid === msg.guid)) return s;
      return { messages: [...s.messages, msg] };
    }),

  updateMessage: (guid, updates) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.guid === guid ? { ...m, ...updates } : m)),
    })),

  replaceTempGuid: (tempGuid, realGuid, updates) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.guid === tempGuid ? { ...m, ...updates, guid: realGuid } : m,
      ),
    })),

  setLoading: (loading) => set({ loading }),
  setHasMore: (hasMore) => set({ hasMore }),
  setReplyToMessage: (msg) => set({ replyToMessage: msg }),
  clearReplyToMessage: () => set({ replyToMessage: null }),
  clear: () => set({ messages: [], loading: false, hasMore: true, replyToMessage: null }),
}));

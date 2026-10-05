import { create } from 'zustand';
import { ChatRecord, db } from '@/lib/db';

interface ChatState {
  /** All chats, most recently active first. */
  chats: ChatRecord[];
  activeChatGuid: string | null;

  setChats: (chats: ChatRecord[]) => void;
  /** Insert or replace chats by guid. Unchanged chats keep their object identity. */
  upsertChats: (chats: ChatRecord[]) => void;
  upsertChat: (chat: ChatRecord) => void;
  setActiveChatGuid: (guid: string | null) => void;
  updateChatLastMessage: (chatGuid: string, text: string | null, date: number, messageGuid: string) => void;
  markChatRead: (chatGuid: string) => void;
  markChatUnread: (chatGuid: string) => void;
  togglePin: (chatGuid: string) => void;
}

function byRecency(a: ChatRecord, b: ChatRecord): number {
  return (b.lastMessageDate ?? 0) - (a.lastMessageDate ?? 0);
}

function sameChat(a: ChatRecord, b: ChatRecord): boolean {
  const keys = Object.keys(b) as (keyof ChatRecord)[];
  for (const key of keys) {
    const av = a[key];
    const bv = b[key];
    if (av === bv) continue;
    if (Array.isArray(av) && Array.isArray(bv) && av.length === bv.length && av.every((v, i) => v === bv[i])) continue;
    return false;
  }
  return true;
}

/** Write local-only chat state through to IndexedDB (fire-and-forget). */
function persist(chatGuid: string, updates: Partial<ChatRecord>) {
  try {
    db.chats.update(chatGuid, updates)?.catch?.((err: unknown) => {
      console.error('[ChatStore] Failed to persist chat state:', err);
    });
  } catch {
    // IndexedDB may not be available in test environment
  }
}

export const useChatStore = create<ChatState>((set) => ({
  chats: [],
  activeChatGuid: null,

  setChats: (chats) => set({ chats: [...chats].sort(byRecency) }),

  upsertChats: (incoming) =>
    set((s) => {
      if (incoming.length === 0) return s;
      const indexByGuid = new Map<string, number>();
      for (let i = 0; i < s.chats.length; i++) indexByGuid.set(s.chats[i].guid, i);

      let next: ChatRecord[] | null = null;
      for (const chat of incoming) {
        const idx = indexByGuid.get(chat.guid);
        if (idx === undefined) {
          next ??= [...s.chats];
          indexByGuid.set(chat.guid, next.length);
          next.push(chat);
        } else if (!sameChat((next ?? s.chats)[idx], chat)) {
          next ??= [...s.chats];
          next[idx] = chat;
        }
      }
      if (!next) return s;
      return { chats: next.sort(byRecency) };
    }),

  upsertChat: (chat) => useChatStore.getState().upsertChats([chat]),

  setActiveChatGuid: (guid) => set({ activeChatGuid: guid }),

  updateChatLastMessage: (chatGuid, text, date, messageGuid) =>
    set((s) => {
      const idx = s.chats.findIndex((c) => c.guid === chatGuid);
      if (idx < 0) return s;
      const next = [...s.chats];
      next[idx] = { ...next[idx], lastMessageText: text, lastMessageDate: date, lastMessageGuid: messageGuid };
      return { chats: next.sort(byRecency) };
    }),

  markChatRead: (chatGuid) =>
    set((s) => {
      const lastReadAt = Date.now();
      persist(chatGuid, { hasUnreadMessage: false, lastReadAt });
      const idx = s.chats.findIndex((c) => c.guid === chatGuid);
      if (idx < 0) return s;
      const next = [...s.chats];
      next[idx] = { ...next[idx], hasUnreadMessage: false, lastReadAt };
      return { chats: next };
    }),

  markChatUnread: (chatGuid) =>
    set((s) => {
      const idx = s.chats.findIndex((c) => c.guid === chatGuid);
      if (idx < 0 || s.chats[idx].hasUnreadMessage) return s;
      persist(chatGuid, { hasUnreadMessage: true });
      const next = [...s.chats];
      next[idx] = { ...next[idx], hasUnreadMessage: true };
      return { chats: next };
    }),

  togglePin: (chatGuid) =>
    set((s) => {
      const chat = s.chats.find((c) => c.guid === chatGuid);
      if (!chat) return s;

      const wasPinned = chat.isPinned;
      let newPinIndex = 0;

      if (!wasPinned) {
        // Assign pinIndex = max existing + 1
        const maxIndex = s.chats
          .filter((c) => c.isPinned)
          .reduce((max, c) => Math.max(max, c.pinIndex ?? 0), -1);
        newPinIndex = maxIndex + 1;
      }

      const updates = {
        isPinned: !wasPinned,
        pinIndex: wasPinned ? 0 : newPinIndex,
      };

      persist(chatGuid, updates);

      return {
        chats: s.chats.map((c) =>
          c.guid === chatGuid ? { ...c, ...updates } : c
        ),
      };
    }),
}));

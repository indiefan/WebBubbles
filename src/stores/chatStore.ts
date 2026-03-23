import { create } from 'zustand';
import { ChatRecord, db } from '@/lib/db';

interface ChatState {
  chats: ChatRecord[];
  activeChatGuid: string | null;

  setChats: (chats: ChatRecord[]) => void;
  upsertChat: (chat: ChatRecord) => void;
  setActiveChatGuid: (guid: string | null) => void;
  updateChatLastMessage: (chatGuid: string, text: string | null, date: number, messageGuid: string) => void;
  markChatRead: (chatGuid: string) => void;
  markChatUnread: (chatGuid: string) => void;
  togglePin: (chatGuid: string) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  chats: [],
  activeChatGuid: null,

  setChats: (chats) => set({ chats }),

  upsertChat: (chat) =>
    set((s) => {
      let newChats: ChatRecord[];
      const idx = s.chats.findIndex((c) => c.guid === chat.guid);
      if (idx >= 0) {
        newChats = [...s.chats];
        newChats[idx] = { ...newChats[idx], ...chat };
      } else {
        newChats = [chat, ...s.chats];
      }
      newChats.sort((a, b) => (b.lastMessageDate ?? 0) - (a.lastMessageDate ?? 0));
      return { chats: newChats };
    }),

  setActiveChatGuid: (guid) => set({ activeChatGuid: guid }),

  updateChatLastMessage: (chatGuid, text, date, messageGuid) =>
    set((s) => {
      const newChats = s.chats.map((c) =>
        c.guid === chatGuid
          ? { ...c, lastMessageText: text, lastMessageDate: date, lastMessageGuid: messageGuid }
          : c
      );
      newChats.sort((a, b) => (b.lastMessageDate ?? 0) - (a.lastMessageDate ?? 0));
      return { chats: newChats };
    }),

  markChatRead: (chatGuid) =>
    set((s) => ({
      chats: s.chats.map((c) => (c.guid === chatGuid ? { ...c, hasUnreadMessage: false } : c)),
    })),

  markChatUnread: (chatGuid) =>
    set((s) => ({
      chats: s.chats.map((c) => (c.guid === chatGuid ? { ...c, hasUnreadMessage: true } : c)),
    })),

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

      // Persist to IndexedDB (fire-and-forget)
      try {
        db.chats.update(chatGuid, updates)?.catch?.((err: any) => {
          console.error('[ChatStore] Failed to persist pin state:', err);
        });
      } catch {
        // IndexedDB may not be available in test environment
      }

      return {
        chats: s.chats.map((c) =>
          c.guid === chatGuid ? { ...c, ...updates } : c
        ),
      };
    }),
}));

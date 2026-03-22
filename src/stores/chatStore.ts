import { create } from 'zustand';
import { ChatRecord } from '@/lib/db';

interface ChatState {
  chats: ChatRecord[];
  activeChatGuid: string | null;

  setChats: (chats: ChatRecord[]) => void;
  upsertChat: (chat: ChatRecord) => void;
  setActiveChatGuid: (guid: string | null) => void;
  updateChatLastMessage: (chatGuid: string, text: string | null, date: number, messageGuid: string) => void;
  markChatRead: (chatGuid: string) => void;
  markChatUnread: (chatGuid: string) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  chats: [],
  activeChatGuid: null,

  setChats: (chats) => set({ chats }),

  upsertChat: (chat) =>
    set((s) => {
      const idx = s.chats.findIndex((c) => c.guid === chat.guid);
      if (idx >= 0) {
        const updated = [...s.chats];
        updated[idx] = { ...updated[idx], ...chat };
        return { chats: updated };
      }
      return { chats: [chat, ...s.chats] };
    }),

  setActiveChatGuid: (guid) => set({ activeChatGuid: guid }),

  updateChatLastMessage: (chatGuid, text, date, messageGuid) =>
    set((s) => ({
      chats: s.chats.map((c) =>
        c.guid === chatGuid
          ? { ...c, lastMessageText: text, lastMessageDate: date, lastMessageGuid: messageGuid }
          : c,
      ),
    })),

  markChatRead: (chatGuid) =>
    set((s) => ({
      chats: s.chats.map((c) => (c.guid === chatGuid ? { ...c, hasUnreadMessage: false } : c)),
    })),

  markChatUnread: (chatGuid) =>
    set((s) => ({
      chats: s.chats.map((c) => (c.guid === chatGuid ? { ...c, hasUnreadMessage: true } : c)),
    })),
}));

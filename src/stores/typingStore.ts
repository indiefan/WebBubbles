import { create } from 'zustand';

interface TypingEntry {
  senderAddress: string;
  timestamp: number;
}

interface TypingState {
  typingByChatGuid: Record<string, TypingEntry>;

  setTyping: (chatGuid: string, senderAddress: string) => void;
  clearTyping: (chatGuid: string) => void;
}

export const TYPING_TIMEOUT_MS = 30_000;

// Track auto-clear timers outside the store to avoid serialization issues
const clearTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const useTypingStore = create<TypingState>((set) => ({
  typingByChatGuid: {},

  setTyping: (chatGuid, senderAddress) => {
    // Clear any existing timer for this chat
    const existing = clearTimers.get(chatGuid);
    if (existing) clearTimeout(existing);

    // Auto-clear in case the "stopped typing" event never arrives
    const timer = setTimeout(() => {
      clearTimers.delete(chatGuid);
      set((s) => {
        const next = { ...s.typingByChatGuid };
        delete next[chatGuid];
        return { typingByChatGuid: next };
      });
    }, TYPING_TIMEOUT_MS);
    clearTimers.set(chatGuid, timer);

    set((s) => ({
      typingByChatGuid: {
        ...s.typingByChatGuid,
        [chatGuid]: { senderAddress, timestamp: Date.now() },
      },
    }));
  },

  clearTyping: (chatGuid) => {
    const existing = clearTimers.get(chatGuid);
    if (existing) {
      clearTimeout(existing);
      clearTimers.delete(chatGuid);
    }
    set((s) => {
      const next = { ...s.typingByChatGuid };
      delete next[chatGuid];
      return { typingByChatGuid: next };
    });
  },
}));

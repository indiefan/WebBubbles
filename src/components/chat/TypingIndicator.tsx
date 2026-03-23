"use client";

import { useTypingStore } from "@/stores/typingStore";
import { useContactStore } from "@/stores/contactStore";

interface TypingIndicatorProps {
  chatGuid: string;
  isGroupChat: boolean;
}

export function TypingIndicator({ chatGuid, isGroupChat }: TypingIndicatorProps) {
  const entry = useTypingStore((s) => s.typingByChatGuid[chatGuid]);
  const { resolveDisplayName } = useContactStore();

  if (!entry) return null;

  return (
    <div className="typing-indicator-container">
      {isGroupChat && entry.senderAddress && (
        <div className="typing-indicator-sender">
          {resolveDisplayName(entry.senderAddress)}
        </div>
      )}
      <div className="typing-indicator">
        <span className="typing-dot" />
        <span className="typing-dot" />
        <span className="typing-dot" />
      </div>
    </div>
  );
}

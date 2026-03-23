"use client";

import React, { useEffect, useRef } from "react";
import { http } from "@/services/http";

// BlueBubbles API reaction type strings
const REACTIONS = [
  { emoji: "❤️", type: "love", label: "Love" },
  { emoji: "👍", type: "like", label: "Like" },
  { emoji: "👎", type: "dislike", label: "Dislike" },
  { emoji: "😂", type: "laugh", label: "Laugh" },
  { emoji: "‼️", type: "emphasize", label: "Emphasize" },
  { emoji: "❓", type: "question", label: "Question" },
];

// Exported for testing
export const REACTION_TYPE_MAP: Record<string, string> = {};
for (const r of REACTIONS) REACTION_TYPE_MAP[r.type] = r.emoji;

interface ReactionPickerProps {
  chatGuid: string;
  messageGuid: string;
  messageText: string | null;
  /** bubble alignment — picker mirrors position */
  isFromMe: boolean;
  onClose: () => void;
}

export function ReactionPicker({ chatGuid, messageGuid, messageText, isFromMe, onClose }: ReactionPickerProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleReact = async (type: string) => {
    onClose();
    try {
      await http.sendReaction(chatGuid, messageText || "", messageGuid, type);
    } catch (err) {
      console.error("[ReactionPicker] Failed to send reaction:", err);
    }
  };

  return (
    <div
      ref={ref}
      className="reaction-picker"
      style={{ [isFromMe ? "right" : "left"]: 0 }}
    >
      {REACTIONS.map((r) => (
        <button
          key={r.type}
          className="reaction-picker-btn"
          title={r.label}
          onClick={() => handleReact(r.type)}
        >
          {r.emoji}
        </button>
      ))}
    </div>
  );
}

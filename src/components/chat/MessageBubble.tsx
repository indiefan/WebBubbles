"use client";

import React, { useEffect, useState, useCallback } from "react";
import { format } from "date-fns";
import { db, MessageRecord } from "@/lib/db";
import { useContactStore } from "@/stores/contactStore";
import { useMessageStore } from "@/stores/messageStore";
import { MessageAttachmentGroup } from "./MessageAttachment";
import { ReactionPicker } from "./ReactionPicker";
import { ReplyPreview } from "./ReplyPreview";

// iMessage associatedMessageType values → emoji
// The server may send EITHER numeric codes OR string names.
// Numeric: Positive values = add reaction, negative = remove
// String:  "love", "like", "dislike", "laugh", "emphasize", "question"
//          with "-" prefix for removal (e.g. "-love")
const REACTION_EMOJI_BY_NUM: Record<number, { emoji: string; base: number }> = {
  2000: { emoji: "❤️", base: 2000 },   // love
  2001: { emoji: "👍", base: 2001 },   // like
  2002: { emoji: "👎", base: 2002 },   // dislike
  2003: { emoji: "😂", base: 2003 },   // laugh
  2004: { emoji: "‼️", base: 2004 },   // emphasize
  2005: { emoji: "❓", base: 2005 },   // question
  3000: { emoji: "❤️", base: 2000 },   // love remove
  3001: { emoji: "👍", base: 2001 },
  3002: { emoji: "👎", base: 2002 },
  3003: { emoji: "😂", base: 2003 },
  3004: { emoji: "‼️", base: 2004 },
  3005: { emoji: "❓", base: 2005 },
};

const REACTION_EMOJI_BY_NAME: Record<string, { emoji: string; base: string }> = {
  "love":       { emoji: "❤️", base: "love" },
  "like":       { emoji: "👍", base: "like" },
  "dislike":    { emoji: "👎", base: "dislike" },
  "laugh":      { emoji: "😂", base: "laugh" },
  "emphasize":  { emoji: "‼️", base: "emphasize" },
  "question":   { emoji: "❓", base: "question" },
  "-love":      { emoji: "❤️", base: "love" },
  "-like":      { emoji: "👍", base: "like" },
  "-dislike":   { emoji: "👎", base: "dislike" },
  "-laugh":     { emoji: "😂", base: "laugh" },
  "-emphasize": { emoji: "‼️", base: "emphasize" },
  "-question":  { emoji: "❓", base: "question" },
};

interface ReactionGroup {
  emoji: string;
  count: number;
  isFromMe: boolean;
}

function parseReactionType(raw: string | number | null | undefined): { emoji: string; base: string; isRemoval: boolean } | null {
  if (raw == null) return null;

  // Try numeric first
  const num = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (!isNaN(num) && REACTION_EMOJI_BY_NUM[num]) {
    const entry = REACTION_EMOJI_BY_NUM[num];
    return { emoji: entry.emoji, base: String(entry.base), isRemoval: num >= 3000 };
  }

  // Try string name (e.g. "love", "-love")
  const str = String(raw).toLowerCase();
  const entry = REACTION_EMOJI_BY_NAME[str];
  if (entry) {
    return { emoji: entry.emoji, base: entry.base, isRemoval: str.startsWith("-") };
  }

  return null;
}

function groupReactions(reactionMessages: MessageRecord[]): ReactionGroup[] {
  // Track net reactions: key = senderAddress|baseType
  const reactionState = new Map<string, { emoji: string; isFromMe: boolean }>();

  // Sort by date so we process in chronological order
  const sorted = [...reactionMessages].sort((a, b) => a.dateCreated - b.dateCreated);

  for (const msg of sorted) {
    const parsed = parseReactionType(msg.associatedMessageType);
    if (!parsed) continue;

    const sender = msg.handleAddress || (msg.isFromMe ? "__me__" : "__unknown__");
    const key = `${sender}|${parsed.base}`;

    if (parsed.isRemoval) {
      reactionState.delete(key);
    } else {
      reactionState.set(key, { emoji: parsed.emoji, isFromMe: msg.isFromMe });
    }
  }

  // Group by emoji
  const grouped = new Map<string, { count: number; isFromMe: boolean }>();
  for (const { emoji, isFromMe } of reactionState.values()) {
    const existing = grouped.get(emoji);
    if (existing) {
      existing.count++;
      if (isFromMe) existing.isFromMe = true;
    } else {
      grouped.set(emoji, { count: 1, isFromMe });
    }
  }

  return Array.from(grouped.entries()).map(([emoji, { count, isFromMe }]) => ({
    emoji,
    count,
    isFromMe,
  }));
}

interface MessageBubbleProps {
  msg: MessageRecord;
  isGroupChat: boolean;
  chatGuid: string;
}

export function MessageBubble({ msg, isGroupChat, chatGuid }: MessageBubbleProps) {
  const { resolveDisplayName } = useContactStore();
  const [reactions, setReactions] = useState<ReactionGroup[]>([]);
  const [showPicker, setShowPicker] = useState(false);

  const isTemp = msg.guid.startsWith("temp-");
  const hasError = msg.error > 0;

  // Load reactions for this message — check both plain GUID and p:N/ prefix formats
  useEffect(() => {
    if (!msg.guid || isTemp) return;
    let cancelled = false;

    const loadReactions = async () => {
      try {
        // iMessage stores associatedMessageGuid as either "GUID" or "p:N/GUID"
        // Query all possible formats in a single lookup
        const reactionMsgs = await db.messages
          .where("associatedMessageGuid")
          .anyOf([
            msg.guid,
            `p:0/${msg.guid}`,
            `p:1/${msg.guid}`,
            `p:2/${msg.guid}`,
            `p:3/${msg.guid}`,
          ])
          .toArray();

        if (!cancelled) {
          setReactions(reactionMsgs.length > 0 ? groupReactions(reactionMsgs) : []);
        }
      } catch (e) {
        console.error("[MessageBubble] Failed to load reactions for", msg.guid, e);
      }
    };

    loadReactions();
    return () => { cancelled = true; };
  }, [msg.guid, isTemp]);

  const formatTime = (ts: number) => {
    return format(new Date(ts), "h:mm a");
  };

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setShowPicker(prev => !prev);
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setShowPicker(prev => !prev);
  }, []);

  const handleReply = useCallback(() => {
    useMessageStore.getState().setReplyToMessage(msg);
    setShowPicker(false);
  }, [msg]);

  return (
    <div key={msg.guid} style={{ position: "relative" }}>
      <div
        className={`message-bubble ${msg.isFromMe ? "sent" : "received"}`}
        style={{ opacity: isTemp ? 0.6 : 1, position: "relative" }}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
      >
        {/* Reply preview — shows what message this is replying to */}
        {msg.threadOriginatorGuid && (
          <ReplyPreview threadOriginatorGuid={msg.threadOriginatorGuid} variant="bubble" />
        )}

        {!msg.isFromMe && isGroupChat && msg.handleAddress && (
          <div style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--accent)",
            marginBottom: 2,
            opacity: 0.9,
          }}>
            {resolveDisplayName(msg.handleAddress)}
          </div>
        )}
        {msg.text && <div>{msg.text}</div>}
        <MessageAttachmentGroup msg={msg} />

        {/* Reaction badges */}
        {reactions.length > 0 && (
          <div className="reaction-badges" style={{
            [msg.isFromMe ? "left" : "right"]: -4,
          }}>
            {reactions.map((r) => (
              <span key={r.emoji} className={`reaction-badge ${r.isFromMe ? "reaction-badge-mine" : ""}`}>
                {r.emoji}{r.count > 1 && <span className="reaction-count">{r.count}</span>}
              </span>
            ))}
          </div>
        )}

        {/* Reaction picker + reply action */}
        {showPicker && (
          <div style={{ position: "absolute", top: -48, display: "flex", gap: 4, zIndex: 100, [msg.isFromMe ? "right" : "left"]: 0 }}>
            <ReactionPicker
              chatGuid={chatGuid}
              messageGuid={msg.guid}
              messageText={msg.text}
              isFromMe={msg.isFromMe}
              onClose={() => setShowPicker(false)}
            />
            <button
              className="reply-action-btn"
              onClick={handleReply}
              title="Reply"
              aria-label="Reply to message"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 17 4 12 9 7" /><path d="M20 18v-2a4 4 0 0 0-4-4H4" />
              </svg>
            </button>
          </div>
        )}
      </div>
      <div style={{
        textAlign: msg.isFromMe ? "right" : "left",
        fontSize: 11,
        color: hasError ? "var(--danger)" : "var(--muted)",
        padding: "2px 4px",
        opacity: 0.7,
      }}>
        {hasError ? "Failed to send" : isTemp ? "Sending..." : formatTime(msg.dateCreated)}
      </div>
    </div>
  );
}

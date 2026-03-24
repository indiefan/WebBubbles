"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import { format } from "date-fns";
import { db, MessageRecord } from "@/lib/db";
import { useContactStore } from "@/stores/contactStore";
import { useMessageStore } from "@/stores/messageStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { http } from "@/services/http";
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

/** Derive the delivery status for a message's status line. Exported for testing. */
export function getDeliveryStatus(msg: MessageRecord): { text: string; className: string } {
  const isTemp = msg.guid.startsWith("temp-");
  const hasError = msg.error > 0;

  // Incoming messages: just show the time
  if (!msg.isFromMe) {
    return { text: format(new Date(msg.dateCreated), "h:mm a"), className: "message-status" };
  }

  if (hasError) {
    return { text: "Failed to send", className: "message-status message-status-error" };
  }
  if (isTemp) {
    return { text: "Sending…", className: "message-status" };
  }
  if (msg.dateRead) {
    const readTime = format(new Date(msg.dateRead), "h:mm a");
    return { text: `Read ${readTime}`, className: "message-status message-status-read" };
  }
  if (msg.dateDelivered) {
    return { text: "Delivered", className: "message-status message-status-delivered" };
  }
  return { text: "Sent", className: "message-status" };
}

export function MessageBubble({ msg, isGroupChat, chatGuid }: MessageBubbleProps) {
  const { resolveDisplayName } = useContactStore();
  const [reactions, setReactions] = useState<ReactionGroup[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(msg.text || "");
  const [editLoading, setEditLoading] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLTextAreaElement>(null);

  const isTemp = msg.guid.startsWith("temp-");
  const hasError = msg.error > 0;
  const isUnsent = !!msg.dateDeleted;
  const isEdited = !!msg.dateEdited && !isUnsent;

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

  // Focus edit input when entering edit mode
  useEffect(() => {
    if (isEditing && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.setSelectionRange(editInputRef.current.value.length, editInputRef.current.value.length);
    }
  }, [isEditing]);

  const formatTime = (ts: number) => {
    return format(new Date(ts), "h:mm a");
  };

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (!isEditing) setShowPicker(prev => !prev);
  }, [isEditing]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (!isEditing) setShowPicker(prev => !prev);
  }, [isEditing]);

  const handleReply = useCallback(() => {
    useMessageStore.getState().setReplyToMessage(msg);
    setShowPicker(false);
  }, [msg]);

  const handleStartEdit = useCallback(() => {
    setEditText(msg.text || "");
    setIsEditing(true);
    setShowPicker(false);
  }, [msg.text]);

  const handleCancelEdit = useCallback(() => {
    setIsEditing(false);
    setEditText(msg.text || "");
  }, [msg.text]);

  const handleSaveEdit = useCallback(async () => {
    const trimmed = editText.trim();
    if (!trimmed || trimmed === msg.text) {
      setIsEditing(false);
      return;
    }
    setEditLoading(true);
    try {
      await http.editMessage(msg.guid, trimmed, trimmed);
      // Optimistically update local state
      const updates = { text: trimmed, dateEdited: Date.now() };
      await db.messages.update(msg.guid, updates);
      useMessageStore.getState().updateMessage(chatGuid, msg.guid, updates);
      setIsEditing(false);
    } catch (err) {
      console.error("[MessageBubble] Edit failed:", err);
    } finally {
      setEditLoading(false);
    }
  }, [editText, msg.guid, msg.text]);

  const handleUnsend = useCallback(async () => {
    setShowPicker(false);
    try {
      await http.unsendMessage(msg.guid);
      // Optimistically update local state
      const updates = { dateDeleted: Date.now(), text: null };
      await db.messages.update(msg.guid, updates);
      useMessageStore.getState().updateMessage(chatGuid, msg.guid, updates);
    } catch (err) {
      console.error("[MessageBubble] Unsend failed:", err);
    }
  }, [msg.guid]);

  const handleEditKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSaveEdit();
    } else if (e.key === "Escape") {
      handleCancelEdit();
    }
  }, [handleSaveEdit, handleCancelEdit]);

  // Can edit/unsend: own message, not temp, not already unsent
  const canModify = msg.isFromMe && !isTemp && !isUnsent;

  const status = getDeliveryStatus(msg);

  return (
    <div key={msg.guid} style={{ position: "relative" }}>
      <div
        className={`message-bubble ${msg.isFromMe ? "sent" : "received"} ${isUnsent ? "message-unsent" : ""}`}
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

        {/* Message content: unsent, editing, or normal */}
        {isUnsent ? (
          <div className="message-unsent-text">Message unsent</div>
        ) : isEditing ? (
          <div className="message-edit-container">
            <textarea
              ref={editInputRef}
              className="message-edit-input"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={handleEditKeyDown}
              disabled={editLoading}
              rows={1}
            />
            <div className="message-edit-actions">
              <button
                className="edit-save-btn"
                onClick={handleSaveEdit}
                disabled={editLoading || !editText.trim() || editText.trim() === msg.text}
              >
                {editLoading ? "…" : "Save"}
              </button>
              <button
                className="edit-cancel-btn"
                onClick={handleCancelEdit}
                disabled={editLoading}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            {msg.text && <div>{msg.text}</div>}
            <MessageAttachmentGroup msg={msg} />
            {isEdited && <div className="message-edited-label">Edited</div>}
          </>
        )}

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

        {/* Reaction picker + action toolbar */}
        {showPicker && (
          <div ref={toolbarRef} style={{ position: "absolute", top: -48, display: "flex", gap: 4, zIndex: 100, [msg.isFromMe ? "right" : "left"]: 0 }}>
            <ReactionPicker
              chatGuid={chatGuid}
              messageGuid={msg.guid}
              messageText={msg.text}
              isFromMe={msg.isFromMe}
              onClose={() => setShowPicker(false)}
              containerRef={toolbarRef}
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
            {canModify && (
              <>
                <button
                  className="reply-action-btn"
                  onClick={handleStartEdit}
                  title="Edit"
                  aria-label="Edit message"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </button>
                <button
                  className="reply-action-btn unsend-action-btn"
                  onClick={handleUnsend}
                  title="Unsend"
                  aria-label="Unsend message"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="1 4 1 10 7 10" />
                    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                  </svg>
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <div className={status.className} style={{
        textAlign: msg.isFromMe ? "right" : "left",
      }}>
        {status.text}
      </div>
    </div>
  );
}


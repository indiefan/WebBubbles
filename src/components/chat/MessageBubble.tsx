"use client";

import React, { memo, useEffect, useState, useCallback, useRef } from "react";
import { format } from "date-fns";
import { db, MessageRecord } from "@/lib/db";
import { useMessageStore } from "@/stores/messageStore";
import { http } from "@/services/http";
import { outgoingQueue } from "@/services/outgoingQueue";
import { NO_REACTIONS, ReactionGroup } from "@/services/reactions";
import { MessageAttachmentGroup } from "./MessageAttachment";
import { ReactionPicker } from "./ReactionPicker";
import { ReplyPreview } from "./ReplyPreview";
import { Avatar } from "@/components/Avatar";

interface MessageBubbleProps {
  msg: MessageRecord;
  chatGuid: string;
  /** Who sent an incoming message in a group chat. */
  senderName?: string | null;
  /** Show the name above the bubble (the first of a run of messages from one person). */
  showSenderName?: boolean;
  /**
   * Group chats show the sender's face beside incoming bubbles: pass their
   * photo, or null to show their initial. Leave undefined for no face at all.
   */
  senderAvatar?: string | null;
  /** Keep the face's space but leave it empty (all but the last of a run). */
  hideFace?: boolean;
  reactions?: ReactionGroup[];
  /** The message this one replies to, when it is loaded. */
  replyTo?: MessageRecord;
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

/**
 * Wording for messages that record a group event instead of carrying content.
 * Returns null for ordinary messages. Exported for testing.
 */
export function describeGroupEvent(msg: MessageRecord, who: string): string | null {
  switch (msg.itemType) {
    case 1:
      return `${who} ${msg.groupActionType === 1 ? "removed someone from" : "added someone to"} the conversation`;
    case 2:
      return msg.groupTitle
        ? `${who} named the conversation “${msg.groupTitle}”`
        : `${who} removed the conversation name`;
    case 3:
      if (msg.groupActionType === 1) return `${who} changed the group photo`;
      if (msg.groupActionType === 2) return `${who} removed the group photo`;
      return `${who} left the conversation`;
    default:
      return null;
  }
}

const URL_PATTERN = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]}'"])/g;

/** Message text with links made clickable. */
function MessageText({ text }: { text: string }) {
  const parts = text.split(URL_PATTERN);
  if (parts.length === 1) return <div className="message-text">{text}</div>;
  return (
    <div className="message-text">
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer">
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </div>
  );
}

function MessageBubbleImpl({
  msg,
  chatGuid,
  senderName,
  showSenderName = true,
  senderAvatar,
  hideFace = false,
  reactions = NO_REACTIONS,
  replyTo,
}: MessageBubbleProps) {
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

  // Focus edit input when entering edit mode
  useEffect(() => {
    if (isEditing && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.setSelectionRange(editInputRef.current.value.length, editInputRef.current.value.length);
    }
  }, [isEditing]);

  const togglePicker = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (!isEditing && !isTemp) setShowPicker(prev => !prev);
  }, [isEditing, isTemp]);

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
  }, [editText, msg.guid, msg.text, chatGuid]);

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
  }, [msg.guid, chatGuid]);

  const handleEditKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSaveEdit();
    } else if (e.key === "Escape") {
      handleCancelEdit();
    }
  }, [handleSaveEdit, handleCancelEdit]);

  const groupEvent = describeGroupEvent(msg, msg.isFromMe ? "You" : senderName || "Someone");
  if (groupEvent) {
    return <div className="message-event">{groupEvent}</div>;
  }

  // Can edit/unsend: own message, not temp, not already unsent
  const canModify = msg.isFromMe && !isTemp && !isUnsent;
  const hasAttachments = (msg.attachments?.length ?? 0) > 0;
  const status = getDeliveryStatus(msg);

  const showFace = senderAvatar !== undefined && !msg.isFromMe;

  return (
    <div className={`message-row ${showFace ? "with-avatar" : ""}`}>
      {showFace && (
        <div className="message-row-avatar">
          {!hideFace && <Avatar name={senderName ?? ""} imageUrl={senderAvatar} size={28} />}
        </div>
      )}
      <div className="message-row-body">
      <div
        className={`message-bubble ${msg.isFromMe ? "sent" : "received"} ${isUnsent ? "message-unsent" : ""}`}
        style={{ opacity: isTemp && !hasError ? 0.6 : 1, position: "relative" }}
        onDoubleClick={togglePicker}
        onContextMenu={togglePicker}
      >
        {/* Reply preview — shows what message this is replying to */}
        {msg.threadOriginatorGuid && (
          <ReplyPreview threadOriginatorGuid={msg.threadOriginatorGuid} variant="bubble" message={replyTo} />
        )}

        {senderName && showSenderName && !msg.isFromMe && <div className="message-sender">{senderName}</div>}

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
            {msg.text && <MessageText text={msg.text} />}
            <MessageAttachmentGroup msg={msg} />
            {!msg.text && !hasAttachments && <div className="message-unsent-text">Unsupported message</div>}
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
      <div className={status.className} style={{ textAlign: msg.isFromMe ? "right" : "left" }}>
        {status.text}
        {hasError && isTemp && (
          <>
            <button className="message-status-action" onClick={() => outgoingQueue.retry(msg.guid)}>
              Retry
            </button>
            <button className="message-status-action" onClick={() => outgoingQueue.discard(msg.guid)}>
              Delete
            </button>
          </>
        )}
      </div>
      </div>
    </div>
  );
}

export const MessageBubble = memo(MessageBubbleImpl);

"use client";

import React, { useEffect, useState } from "react";
import { db, MessageRecord } from "@/lib/db";
import { useContactStore } from "@/stores/contactStore";

interface ReplyPreviewProps {
  /** The GUID of the original message being replied to */
  threadOriginatorGuid: string;
  /** Visual variant: 'bubble' for inline on a message, 'banner' for compose area */
  variant: "bubble" | "banner";
  /** If variant='banner', an optional close handler */
  onDismiss?: () => void;
  /** Pre-loaded message to avoid DB lookup (used by compose banner) */
  message?: MessageRecord;
}

export function ReplyPreview({ threadOriginatorGuid, variant, onDismiss, message }: ReplyPreviewProps) {
  const [original, setOriginal] = useState<MessageRecord | null>(message ?? null);
  const { resolveDisplayName } = useContactStore();

  useEffect(() => {
    if (message) return; // already have it
    let cancelled = false;

    // The threadOriginatorGuid can be bare "GUID" or "p:N/GUID"
    const rawGuid = threadOriginatorGuid.includes("/")
      ? threadOriginatorGuid.split("/").slice(1).join("/")
      : threadOriginatorGuid;

    db.messages.get(rawGuid).then((msg) => {
      if (!cancelled && msg) setOriginal(msg);
    });

    return () => { cancelled = true; };
  }, [threadOriginatorGuid, message]);

  if (!original) return null;

  const senderName = original.isFromMe
    ? "You"
    : resolveDisplayName(original.handleAddress ?? "");

  const previewText = original.text
    ? original.text.length > 80 ? original.text.slice(0, 80) + "…" : original.text
    : original.hasAttachments ? "Attachment" : "Message";

  if (variant === "banner") {
    return (
      <div className="reply-banner">
        <div className="reply-banner-line" />
        <div className="reply-banner-content">
          <span className="reply-banner-sender">{senderName}</span>
          <span className="reply-banner-text">{previewText}</span>
        </div>
        {onDismiss && (
          <button className="reply-banner-dismiss" onClick={onDismiss} aria-label="Cancel reply">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>
    );
  }

  // variant === "bubble"
  return (
    <div className="reply-preview">
      <div className="reply-preview-line" />
      <div className="reply-preview-content">
        <span className="reply-preview-sender">{senderName}</span>
        <span className="reply-preview-text">{previewText}</span>
      </div>
    </div>
  );
}

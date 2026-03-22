"use client";

import React from "react";
import { format } from "date-fns";
import { MessageRecord } from "@/lib/db";
import { useContactStore } from "@/stores/contactStore";
import { MessageAttachmentGroup } from "./MessageAttachment";

interface MessageBubbleProps {
  msg: MessageRecord;
  isGroupChat: boolean;
}

export function MessageBubble({ msg, isGroupChat }: MessageBubbleProps) {
  const { resolveDisplayName } = useContactStore();

  const isTemp = msg.guid.startsWith("temp-");
  const hasError = msg.error > 0;

  const formatTime = (ts: number) => {
    return format(new Date(ts), "h:mm a");
  };

  return (
    <div key={msg.guid}>
      <div className={`message-bubble ${msg.isFromMe ? "sent" : "received"}`} style={{ opacity: isTemp ? 0.6 : 1 }}>
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

"use client";

import React, { useEffect, useState, useRef } from "react";
import { db } from "@/lib/db";
import { useMessageStore } from "@/stores/messageStore";
import { outgoingQueue } from "@/services/outgoingQueue";
import { AttachmentPreview } from "./AttachmentPreview";
import { ReplyPreview } from "./ReplyPreview";

interface ComposeAreaProps {
  chatGuid: string;
  onSend: () => void;
}

export function ComposeArea({ chatGuid, onSend }: ComposeAreaProps) {
  const [text, setText] = useState("");
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const replyToMessage = useMessageStore((s) => s.replyToMessage);

  // Load draft from IndexedDB
  useEffect(() => {
    db.drafts.get(chatGuid).then((d) => {
      if (d) {
        setText(d.text);
        setDraft(d.text);
      }
    });
  }, [chatGuid]);

  // Auto-save draft
  useEffect(() => {
    if (text !== draft) {
      const timer = setTimeout(() => {
        db.drafts.put({ chatGuid, text, attachmentPaths: [], updatedAt: Date.now() });
        setDraft(text);
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [text, draft, chatGuid]);

  // Focus input when reply is set
  useEffect(() => {
    if (replyToMessage) {
      inputRef.current?.focus();
    }
  }, [replyToMessage]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() && files.length === 0) return;

    const messageText = text.trim();
    const messageFiles = [...files];
    const replyGuid = replyToMessage?.guid ?? undefined;
    setText("");
    setFiles([]);

    // Clear draft
    db.drafts.delete(chatGuid).catch(() => {});

    // Clear reply state
    useMessageStore.getState().clearReplyToMessage();

    // Notify parent to set scroll flags
    onSend();

    outgoingQueue.enqueue({
      chatGuid: chatGuid,
      tempGuid: outgoingQueue.generateTempGuid(),
      text: messageText,
      attachments: messageFiles,
      selectedMessageGuid: replyGuid,
    });
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setFiles(prev => [...prev, ...Array.from(e.target.files!)]);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files) {
      setFiles(prev => [...prev, ...Array.from(e.dataTransfer.files!)]);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }} onDragOver={handleDragOver} onDrop={handleDrop}>
      {/* Reply banner */}
      {replyToMessage && (
        <ReplyPreview
          threadOriginatorGuid={replyToMessage.guid}
          variant="banner"
          message={replyToMessage}
          onDismiss={() => useMessageStore.getState().clearReplyToMessage()}
        />
      )}
      <AttachmentPreview files={files} onRemove={(i) => setFiles(f => f.filter((_, idx) => idx !== i))} />
      <form className="compose-area" onSubmit={handleSend} style={{ display: 'flex', alignItems: 'center' }}>
        <button type="button" onClick={() => fileInputRef.current?.click()} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 8px', color: 'var(--muted)' }}>
          <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>
        </button>
        <input type="file" ref={fileInputRef} multiple onChange={handleFileChange} style={{ display: 'none' }} />
        <input
          ref={inputRef}
          type="text"
          className="compose-input"
          placeholder={replyToMessage ? "Reply…" : "iMessage"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          style={{ flex: 1 }}
        />
        <button type="submit" className="send-button" disabled={!text.trim() && files.length === 0}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"></line>
            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
          </svg>
        </button>
      </form>
    </div>
  );
}


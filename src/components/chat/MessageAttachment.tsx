"use client";

import React, { useEffect, useState } from "react";
import { Blurhash } from "react-blurhash";
import { db, AttachmentRecord, MessageRecord } from "@/lib/db";
import { downloadService } from "@/services/downloads";
import { useDownloadStore } from "@/stores/downloadStore";

export function MessageAttachmentGroup({ msg }: { msg: MessageRecord }) {
  const [attachments, setAttachments] = useState<AttachmentRecord[]>([]);

  useEffect(() => {
    if (!msg.hasAttachments) return;
    db.attachments.where({ messageGuid: msg.guid }).toArray().then(setAttachments);
  }, [msg.guid, msg.hasAttachments]);

  if (!msg.hasAttachments || attachments.length === 0) return null;

  return (
    <div className="message-attachments" style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
      {attachments.map(att => (
        <MessageAttachment key={att.guid} attachment={att} />
      ))}
    </div>
  );
}

function MessageAttachment({ attachment }: { attachment: AttachmentRecord }) {
  const [url, setUrl] = useState<string>("");
  const [blurhash, setBlurhash] = useState<string>("");
  
  const loading = useDownloadStore(s => s.loading[attachment.guid]);
  const progress = useDownloadStore(s => s.progress[attachment.guid] || 0);

  useEffect(() => {
    let mounted = true;
    
    const isMedia = attachment.mimeType?.startsWith("image/") || attachment.mimeType?.startsWith("video/");

    if (isMedia) {
      downloadService.getBlurhash(attachment.guid).then(bh => {
        if (mounted && bh) setBlurhash(bh);
      });
    }

    // Auto-download for this phase
    downloadService.getAttachmentUrl(attachment.guid)
      .then(u => { if (mounted) setUrl(u); })
      .catch(e => console.error("Failed to load attachment", e));

    return () => { mounted = false; };
  }, [attachment.guid, attachment.mimeType]);

  const isImage = attachment.mimeType?.startsWith("image/");
  const isVideo = attachment.mimeType?.startsWith("video/");
  const isAudio = attachment.mimeType?.startsWith("audio/");

  const containerStyle: React.CSSProperties = {
    position: 'relative',
    maxWidth: 240,
    maxHeight: 240,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.1)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };

  if (!url) {
    return (
      <div style={containerStyle}>
        {blurhash ? (
          <Blurhash
            hash={blurhash}
            width={240}
            height={Math.min(240, (attachment.height || 240) * (240 / (attachment.width || 240)) || 160)}
            resolutionX={32}
            resolutionY={32}
            punch={1}
          />
        ) : (
          <div style={{ width: 160, height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {loading ? <span className="loading-spinner" style={{ width: 24, height: 24 }} /> : <span style={{fontSize: 12, color: 'var(--muted)'}}>Waiting...</span>}
          </div>
        )}
      </div>
    );
  }

  if (isImage) {
    return <img src={url} alt={attachment.transferName || "Image"} style={{ maxWidth: 240, maxHeight: 240, borderRadius: 12, objectFit: 'cover' }} />;
  }

  if (isVideo) {
    return <video src={url} controls style={{ maxWidth: 240, maxHeight: 240, borderRadius: 12 }} />;
  }

  if (isAudio) {
    return <audio src={url} controls style={{ maxWidth: 240 }} />;
  }

  return (
    <div style={{ padding: '8px 12px', backgroundColor: 'rgba(0,0,0,0.05)', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
      <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>
      <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>
        {attachment.transferName || 'File'}
      </span>
    </div>
  );
}

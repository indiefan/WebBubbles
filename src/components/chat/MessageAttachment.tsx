"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AttachmentRecord, MessageRecord } from "@/lib/db";
import { AttachmentVariant, downloadService } from "@/services/downloads";
import { outgoingQueue } from "@/services/outgoingQueue";

const MAX_WIDTH = 240;
const MAX_HEIGHT = 320;
// Used when the server doesn't know an image's dimensions
const FALLBACK_SIZE = { width: 240, height: 180 };

/** The on-screen box for a visual attachment, known before any bytes arrive. */
function displaySize(att: AttachmentRecord): { width: number; height: number } | null {
  if (!att.width || !att.height) return null;
  const scale = Math.min(MAX_WIDTH / att.width, MAX_HEIGHT / att.height, 1);
  return { width: Math.round(att.width * scale), height: Math.round(att.height * scale) };
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** True once the element has come within a screen or so of the viewport. */
function useNearViewport(ref: React.RefObject<HTMLElement | null>): boolean {
  // Without IntersectionObserver there is no way to wait, so load right away
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { rootMargin: "800px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, near]);
  return near;
}

/** Load an attachment while `enabled`, releasing it when the component goes away. */
function useAttachmentUrl(guid: string, variant: AttachmentVariant, enabled: boolean) {
  const [state, setState] = useState<{ key: string; url: string | null; failed: boolean }>({
    key: "",
    url: null,
    failed: false,
  });
  const key = `${variant}:${guid}`;

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let acquired = false;

    downloadService
      .acquire(guid, variant)
      .then((url) => {
        if (!alive) {
          downloadService.release(guid, variant);
          return;
        }
        acquired = true;
        setState({ key, url, failed: false });
      })
      .catch(() => {
        if (alive) setState({ key, url: null, failed: true });
      });

    return () => {
      alive = false;
      if (acquired) downloadService.release(guid, variant);
    };
  }, [guid, variant, enabled, key]);

  // A result for a different attachment is stale
  return state.key === key ? state : { key, url: null, failed: false };
}

/** Object URL for a file that is still uploading. */
function useLocalFileUrl(file: File | undefined): string | null {
  const url = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);
  return url;
}

export function MessageAttachmentGroup({ msg }: { msg: MessageRecord }) {
  const attachments = msg.attachments ?? [];
  if (attachments.length === 0) return null;

  return (
    <div className="message-attachments">
      {attachments.map((att) => (
        <MessageAttachment key={att.guid} attachment={att} />
      ))}
    </div>
  );
}

function MessageAttachment({ attachment }: { attachment: AttachmentRecord }) {
  const mime = attachment.mimeType ?? "";
  if (mime.startsWith("image/")) return <ImageAttachment attachment={attachment} />;
  if (mime.startsWith("video/")) return <VideoAttachment attachment={attachment} />;
  if (mime.startsWith("audio/")) return <AudioAttachment attachment={attachment} />;
  return <FileAttachment attachment={attachment} />;
}

function ImageAttachment({ attachment }: { attachment: AttachmentRecord }) {
  const ref = useRef<HTMLDivElement>(null);
  const near = useNearViewport(ref);
  const [lightbox, setLightbox] = useState(false);

  const localUrl = useLocalFileUrl(outgoingQueue.localFile(attachment.guid));
  // The server can't resize GIFs, and a resized one would lose its animation anyway
  const variant: AttachmentVariant = attachment.mimeType === "image/gif" ? "full" : "thumb";
  const { url: remoteUrl, failed } = useAttachmentUrl(attachment.guid, variant, near && !localUrl);
  const url = localUrl ?? remoteUrl;

  const known = displaySize(attachment);
  const box = known ?? (url ? null : FALLBACK_SIZE);

  return (
    <div ref={ref} className="attachment-box" style={box ?? undefined}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={attachment.transferName || "Image"}
          decoding="async"
          style={known ? { width: "100%", height: "100%" } : { maxWidth: MAX_WIDTH, maxHeight: MAX_HEIGHT }}
          onClick={localUrl ? undefined : () => setLightbox(true)}
        />
      ) : (
        <span className="attachment-placeholder">{failed ? "Couldn’t load image" : ""}</span>
      )}
      {lightbox && <Lightbox attachment={attachment} previewUrl={url} onClose={() => setLightbox(false)} />}
    </div>
  );
}

/** Full-screen view of an image at its original resolution. */
function Lightbox({
  attachment,
  previewUrl,
  onClose,
}: {
  attachment: AttachmentRecord;
  previewUrl: string | null;
  onClose: () => void;
}) {
  const { url: fullUrl } = useAttachmentUrl(attachment.guid, "full", true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="lightbox" onClick={onClose}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={fullUrl ?? previewUrl ?? undefined} alt={attachment.transferName || "Image"} />
    </div>,
    document.body,
  );
}

function VideoAttachment({ attachment }: { attachment: AttachmentRecord }) {
  // Videos are large, so nothing is downloaded until the user asks to play
  const [requested, setRequested] = useState(false);
  const localUrl = useLocalFileUrl(outgoingQueue.localFile(attachment.guid));
  const { url: remoteUrl, failed } = useAttachmentUrl(attachment.guid, "full", requested && !localUrl);
  const url = localUrl ?? remoteUrl;
  const box = displaySize(attachment) ?? FALLBACK_SIZE;

  if (url) {
    return (
      <div className="attachment-box" style={box}>
        <video src={url} controls autoPlay={requested} style={{ width: "100%", height: "100%" }} />
      </div>
    );
  }

  return (
    <button
      type="button"
      className="attachment-box attachment-video-placeholder"
      style={box}
      onClick={() => setRequested(true)}
      disabled={requested && !failed}
      aria-label="Play video"
    >
      {requested && !failed ? (
        <span className="loading-spinner" style={{ width: 24, height: 24 }} />
      ) : (
        <>
          <svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4" /></svg>
          <span>{failed ? "Couldn’t load video" : formatBytes(attachment.totalBytes)}</span>
        </>
      )}
    </button>
  );
}

function AudioAttachment({ attachment }: { attachment: AttachmentRecord }) {
  const ref = useRef<HTMLDivElement>(null);
  const near = useNearViewport(ref);
  const localUrl = useLocalFileUrl(outgoingQueue.localFile(attachment.guid));
  const { url: remoteUrl } = useAttachmentUrl(attachment.guid, "full", near && !localUrl);
  const url = localUrl ?? remoteUrl;

  return (
    <div ref={ref} style={{ width: MAX_WIDTH, minHeight: 40 }}>
      {url && <audio src={url} controls style={{ width: "100%" }} />}
    </div>
  );
}

function FileAttachment({ attachment }: { attachment: AttachmentRecord }) {
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const url = await downloadService.acquire(attachment.guid, "full");
      const link = document.createElement("a");
      link.href = url;
      link.download = attachment.transferName || "attachment";
      link.click();
      downloadService.release(attachment.guid, "full");
    } catch (e) {
      console.error("[Attachment] Download failed", e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <button type="button" className="attachment-file" onClick={save} disabled={saving}>
      <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>
      <span className="attachment-file-name">{attachment.transferName || "File"}</span>
      <span className="attachment-file-size">{saving ? "Saving…" : formatBytes(attachment.totalBytes)}</span>
    </button>
  );
}

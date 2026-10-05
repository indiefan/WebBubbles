// Attachment loading.
//
// Blobs are kept in Cache Storage so they survive reloads. In memory, each
// attachment has at most one object URL, shared by every component showing it
// and revoked once nothing has used it for a while.

import { http } from "./http";
import { useDownloadStore } from "@/stores/downloadStore";

/** `thumb` is an image shrunk to bubble size; `full` is the original file. */
export type AttachmentVariant = "thumb" | "full";

const CACHE_NAME = "bb-attachments";
// Bubbles are at most 240x320 CSS px; this covers high-density displays
const THUMB_MAX_EDGE = 720;
// Images already this small are shown as they are
const THUMB_MIN_BYTES = 350 * 1024;
/** How long an unused object URL is kept before it is revoked. */
const IDLE_REVOKE_MS = 60_000;

interface Entry {
  url: string;
  refs: number;
  idleSince: number;
}

class DownloadService {
  private entries = new Map<string, Entry>();
  private inFlight = new Map<string, Promise<string>>();
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;

  private key(guid: string, variant: AttachmentVariant) {
    return `${variant}:${guid}`;
  }

  /**
   * Get an object URL for an attachment and hold a reference to it.
   * Every acquire must be paired with a release.
   */
  async acquire(guid: string, variant: AttachmentVariant = "full"): Promise<string> {
    const key = this.key(guid, variant);
    const entry = this.entries.get(key);
    if (entry) {
      entry.refs++;
      return entry.url;
    }

    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.load(guid, variant).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pending);
    }
    const url = await pending;

    // Concurrent callers all waited on the same download
    const created = this.entries.get(key);
    if (created) {
      created.refs++;
      return created.url;
    }
    this.entries.set(key, { url, refs: 1, idleSince: 0 });
    return url;
  }

  release(guid: string, variant: AttachmentVariant = "full") {
    const entry = this.entries.get(this.key(guid, variant));
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs === 0) {
      entry.idleSince = Date.now();
      this.scheduleSweep();
    }
  }

  /** One-shot URL for callers that don't track lifetime (kept until the page unloads). */
  async getAttachmentUrl(guid: string): Promise<string> {
    return this.acquire(guid, "full");
  }

  private scheduleSweep() {
    if (this.sweepTimer) return;
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null;
      const now = Date.now();
      let idleRemain = false;
      for (const [key, entry] of this.entries) {
        if (entry.refs > 0) continue;
        if (now - entry.idleSince >= IDLE_REVOKE_MS) {
          URL.revokeObjectURL(entry.url);
          this.entries.delete(key);
        } else {
          idleRemain = true;
        }
      }
      if (idleRemain) this.scheduleSweep();
    }, IDLE_REVOKE_MS);
  }

  private async load(guid: string, variant: AttachmentVariant): Promise<string> {
    // Cache Storage only exists in secure contexts; without it, just download
    const cache = typeof caches !== "undefined" ? await caches.open(CACHE_NAME).catch(() => null) : null;
    const fullKey = `/api/v1/attachment/${guid}/download`;
    const thumbKey = `${fullKey}?variant=thumb-v2`;

    const cached = await cache?.match(variant === "full" ? fullKey : thumbKey);
    if (cached) return URL.createObjectURL(await cached.blob());

    // An original cached earlier can be turned into a thumbnail without the network
    let original = variant === "thumb" ? await cache?.match(fullKey).then((r) => r?.blob()) : undefined;
    if (!original) {
      useDownloadStore.getState().setLoading(guid, true);
      try {
        original = await http.downloadAttachment(guid);
      } finally {
        useDownloadStore.getState().setLoading(guid, false);
      }
    }

    const blob = variant === "thumb" ? await makeThumbnail(original) : original;
    // Best effort: a full disk shouldn't stop the attachment from showing
    await cache?.put(variant === "full" ? fullKey : thumbKey, new Response(blob)).catch(() => {});
    return URL.createObjectURL(blob);
  }
}

/**
 * Shrink an image to bubble size. Done here rather than by the server, whose
 * resizer drops EXIF rotation (portrait iPhone photos come back sideways) and
 * returns PNGs that are often larger than the original.
 *
 * Falls back to the original whenever the image can't be processed.
 */
async function makeThumbnail(original: Blob): Promise<Blob> {
  if (original.size <= THUMB_MIN_BYTES || original.type === "image/gif") return original;
  if (typeof createImageBitmap !== "function") return original;

  try {
    // Decoding from a blob applies the EXIF orientation
    const bitmap = await createImageBitmap(original);
    try {
      const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
      if (scale === 1) return original;
      const width = Math.round(bitmap.width * scale);
      const height = Math.round(bitmap.height * scale);
      // JPEG has no transparency, so PNGs (screenshots, stickers) stay PNG
      const type = original.type === "image/png" ? "image/png" : "image/jpeg";

      if (typeof OffscreenCanvas !== "undefined") {
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext("2d");
        if (!ctx) return original;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bitmap, 0, 0, width, height);
        return await canvas.convertToBlob({ type, quality: 0.85 });
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return original;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.85));
      return blob ?? original;
    } finally {
      bitmap.close();
    }
  } catch {
    return original;
  }
}

export const downloadService = new DownloadService();

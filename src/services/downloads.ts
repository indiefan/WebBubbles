// Attachment loading.
//
// Blobs are kept in Cache Storage so they survive reloads. In memory, each
// attachment has at most one object URL, shared by every component showing it
// and revoked once nothing has used it for a while.

import { http } from "./http";
import { useDownloadStore } from "@/stores/downloadStore";

/** `thumb` is a server-resized image for message bubbles; `full` is the original file. */
export type AttachmentVariant = "thumb" | "full";

const CACHE_NAME = "bb-attachments";
// Bubbles are at most 240 CSS px wide; this covers high-density displays
const THUMB_WIDTH = 720;
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
    const cacheKey =
      variant === "full" ? `/api/v1/attachment/${guid}/download` : `/api/v1/attachment/${guid}/download?variant=thumb`;

    const cached = await cache?.match(cacheKey);
    if (cached) return URL.createObjectURL(await cached.blob());

    useDownloadStore.getState().setLoading(guid, true);
    try {
      const blob =
        variant === "thumb"
          ? await http.downloadAttachment(guid, { width: THUMB_WIDTH, quality: "better" })
          : await http.downloadAttachment(guid);
      // Best effort: a full disk shouldn't stop the attachment from showing
      await cache?.put(cacheKey, new Response(blob)).catch(() => {});
      return URL.createObjectURL(blob);
    } finally {
      useDownloadStore.getState().setLoading(guid, false);
    }
  }
}

export const downloadService = new DownloadService();

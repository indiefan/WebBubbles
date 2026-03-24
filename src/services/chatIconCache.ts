// Chat icon cache — fetches, caches, and serves chat icon blob URLs.
// Simple in-memory Map since chat count is small relative to attachments.

import { http } from "./http";

class ChatIconCache {
  private cache = new Map<string, string>(); // chatGuid → object URL
  private pending = new Map<string, Promise<string | null>>();

  /**
   * Returns an object URL for the chat's custom icon, or null if none exists.
   * Results are cached in memory; subsequent calls return immediately.
   */
  async getChatIconUrl(chatGuid: string): Promise<string | null> {
    // Return cached URL if we have one
    const cached = this.cache.get(chatGuid);
    if (cached) return cached;

    // Deduplicate concurrent requests for the same guid
    if (this.pending.has(chatGuid)) {
      return this.pending.get(chatGuid)!;
    }

    const promise = this._fetch(chatGuid);
    this.pending.set(chatGuid, promise);
    promise.finally(() => this.pending.delete(chatGuid));
    return promise;
  }

  /**
   * Invalidate cached icon for a chat (call after upload or delete).
   */
  invalidate(chatGuid: string) {
    const url = this.cache.get(chatGuid);
    if (url) {
      URL.revokeObjectURL(url);
      this.cache.delete(chatGuid);
    }
  }

  private async _fetch(chatGuid: string): Promise<string | null> {
    try {
      const blob = await http.getChatIcon(chatGuid);
      if (!blob || blob.size === 0) return null;
      const url = URL.createObjectURL(blob);
      this.cache.set(chatGuid, url);
      return url;
    } catch {
      // 404 or network error — no icon for this chat
      return null;
    }
  }
}

export const chatIconCache = new ChatIconCache();

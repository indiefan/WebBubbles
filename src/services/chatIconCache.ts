// Chat icon cache — fetches, caches, and serves group photo blob URLs.
// Simple in-memory Map since chat count is small relative to attachments.

import { db } from "@/lib/db";
import { useChatStore } from "@/stores/chatStore";
import { http } from "./http";

/** How long "this group has no photo" is believed before asking again. */
const RECHECK_AFTER_MS = 24 * 3600_000;

type IconResult = { state: "present"; url: string } | { state: "absent" } | { state: "unknown" };

class ChatIconCache {
  private cache = new Map<string, string>(); // chatGuid → object URL
  private pending = new Map<string, Promise<IconResult>>();
  private sweep: Promise<void> | null = null;

  /**
   * Returns an object URL for the chat's custom icon, or null if none exists.
   * Results are cached in memory; subsequent calls return immediately.
   */
  async getChatIconUrl(chatGuid: string): Promise<string | null> {
    const result = await this.load(chatGuid);
    return result.state === "present" ? result.url : null;
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

  /**
   * Find out which group chats have a photo. The server has to be asked chat
   * by chat, so the answer is stored on the chat and only refreshed daily.
   */
  refreshGroupIcons(): Promise<void> {
    this.sweep ??= this.runSweep().finally(() => {
      this.sweep = null;
    });
    return this.sweep;
  }

  private async runSweep() {
    const now = Date.now();
    const due = useChatStore
      .getState()
      .chats.filter((c) => (c.participantHandleAddresses?.length ?? 0) > 1)
      .filter((c) => !c.iconCheckedAt || now - c.iconCheckedAt > RECHECK_AFTER_MS)
      .map((c) => c.guid);

    const worker = async () => {
      for (let guid = due.shift(); guid; guid = due.shift()) {
        const result = await this.load(guid);
        // A failed request says nothing about whether the group has a photo
        if (result.state === "unknown") continue;
        const updates = { hasIcon: result.state === "present", iconCheckedAt: Date.now() };
        await db.chats.update(guid, updates);
        const chat = useChatStore.getState().chats.find((c) => c.guid === guid);
        if (chat) useChatStore.getState().upsertChat({ ...chat, ...updates });
      }
    };
    await Promise.all([worker(), worker()]);
  }

  private load(chatGuid: string): Promise<IconResult> {
    const cached = this.cache.get(chatGuid);
    if (cached) return Promise.resolve({ state: "present", url: cached });

    // Deduplicate concurrent requests for the same guid
    let pending = this.pending.get(chatGuid);
    if (!pending) {
      pending = this.fetch(chatGuid).finally(() => this.pending.delete(chatGuid));
      this.pending.set(chatGuid, pending);
    }
    return pending;
  }

  private async fetch(chatGuid: string): Promise<IconResult> {
    try {
      const blob = await http.getChatIcon(chatGuid);
      if (!blob || blob.size === 0) return { state: "absent" };
      const url = URL.createObjectURL(blob);
      this.cache.set(chatGuid, url);
      return { state: "present", url };
    } catch (err) {
      const notFound = err instanceof Error && err.message.startsWith("HTTP 404");
      return { state: notFound ? "absent" : "unknown" };
    }
  }
}

export const chatIconCache = new ChatIconCache();

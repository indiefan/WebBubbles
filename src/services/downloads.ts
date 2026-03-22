import { http } from "./http";
import { useDownloadStore } from "@/stores/downloadStore";

class DownloadService {
  private downloadPromises = new Map<string, Promise<string>>();

  async getAttachmentUrl(guid: string): Promise<string> {
    if (this.downloadPromises.has(guid)) {
      return this.downloadPromises.get(guid)!;
    }

    const promise = this._fetchAndCache(guid);
    this.downloadPromises.set(guid, promise);
    
    promise.finally(() => {
      this.downloadPromises.delete(guid);
    });

    return promise;
  }

  private async _fetchAndCache(guid: string): Promise<string> {
    if (typeof caches === "undefined") {
      // Fallback for SSR
      return "";
    }

    const cache = await caches.open('bb-attachments');
    const reqUrl = `/api/v1/attachment/${guid}/download`;

    try {
      const cached = await cache.match(reqUrl);
      if (cached) {
        const blob = await cached.blob();
        return URL.createObjectURL(blob);
      }

      useDownloadStore.getState().setLoading(guid, true);
      const blob = await http.downloadAttachment(guid);
      
      const response = new Response(blob);
      await cache.put(reqUrl, response);
      
      useDownloadStore.getState().setLoading(guid, false);
      return URL.createObjectURL(blob);
    } catch (e) {
      useDownloadStore.getState().setLoading(guid, false);
      console.error("Failed to download attachment", guid, e);
      throw e;
    }
  }

  async getBlurhash(guid: string): Promise<string | null> {
    try {
      const res = await http.attachmentBlurhash(guid);
      return res?.data || null;
    } catch (e) {
      console.error("Failed to fetch blurhash", guid, e);
      return null;
    }
  }
}

export const downloadService = new DownloadService();

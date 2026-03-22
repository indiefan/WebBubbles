// Full HTTP service wrapping the BlueBubbles server REST API.
// All methods pass `guid` query param for auth, use no-store cache, and include error handling.

type RequestOptions = {
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number) => void;
};

export class HttpService {
  private baseUrl = '';
  private password = '';
  private timeout = 30_000;
  private customHeaders: Record<string, string> = {};

  configure(serverAddress: string, password: string) {
    this.baseUrl = serverAddress.replace(/\/$/, '');
    this.password = password;

    // Auto-inject headers for tunnel providers
    if (this.baseUrl.includes('ngrok')) {
      this.customHeaders['ngrok-skip-browser-warning'] = 'true';
    } else if (this.baseUrl.includes('zrok')) {
      this.customHeaders['skip_zrok_interstitial'] = 'true';
    }
  }

  get apiRoot() {
    return `${this.baseUrl}/api/v1`;
  }

  private params(extra: Record<string, string | number | boolean | undefined> = {}): string {
    const p = new URLSearchParams();
    p.set('guid', this.password);
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined && v !== null) p.set(k, String(v));
    }
    return p.toString();
  }

  private async request<T = any>(
    method: string,
    path: string,
    opts: {
      query?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
      responseType?: 'json' | 'blob';
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {},
  ): Promise<T> {
    const url = `${this.apiRoot}${path}?${this.params(opts.query)}`;
    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs ?? this.timeout;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    console.log(`[HTTP] ${method} ${path}`, opts.body ? JSON.stringify(opts.body).slice(0, 200) : '');

    try {
      const res = await fetch(url, {
        method,
        headers: {
          ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
          ...this.customHeaders,
        },
        body: opts.body
          ? opts.body instanceof FormData
            ? opts.body
            : JSON.stringify(opts.body)
          : undefined,
        signal: opts.signal ?? controller.signal,
        cache: 'no-store',
      });

      clearTimeout(timeoutId);
      console.log(`[HTTP] ${method} ${path} → ${res.status}`);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(`[HTTP] Error body:`, text);
        throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
      }

      if (opts.responseType === 'blob') {
        return (await res.blob()) as T;
      }
      const json = await res.json();
      return json as T;
    } catch (e: any) {
      clearTimeout(timeoutId);
      console.error(`[HTTP] ${method} ${path} failed:`, e.message);
      if (e.name === 'AbortError') {
        throw new Error(`Request timed out after ${timeoutMs / 1000}s: ${method} ${path}`);
      }
      throw e;
    }
  }

  // ─── Server ──────────────────────────────────────────
  ping(signal?: AbortSignal) {
    return this.request('GET', '/ping', { signal });
  }

  serverInfo(signal?: AbortSignal) {
    return this.request('GET', '/server/info', { signal });
  }

  serverStatTotals() {
    return this.request('GET', '/server/statistics/totals');
  }

  // ─── Chats ───────────────────────────────────────────
  queryChats(opts: { withQuery?: string[]; offset?: number; limit?: number; sort?: string } = {}) {
    return this.request('POST', '/chat/query', {
      body: {
        with: opts.withQuery ?? ['lastmessage', 'participants'],
        offset: opts.offset ?? 0,
        limit: opts.limit ?? 100,
        sort: opts.sort,
      },
    });
  }

  chatCount() {
    return this.request('GET', '/chat/count');
  }

  singleChat(guid: string, withQuery = '') {
    return this.request('GET', `/chat/${encodeURIComponent(guid)}`, { query: { with: withQuery } });
  }

  chatMessages(
    guid: string,
    opts: { withQuery?: string; sort?: string; before?: number; after?: number; offset?: number; limit?: number } = {},
  ) {
    return this.request('GET', `/chat/${encodeURIComponent(guid)}/message`, {
      query: {
        with: opts.withQuery ?? 'attachment,handle,message.attributedBody,message.messageSummaryInfo,message.payloadData',
        sort: opts.sort ?? 'DESC',
        before: opts.before,
        after: opts.after,
        offset: opts.offset ?? 0,
        limit: opts.limit ?? 50,
      },
    });
  }

  markChatRead(guid: string) {
    return this.request('POST', `/chat/${encodeURIComponent(guid)}/read`);
  }

  markChatUnread(guid: string) {
    return this.request('POST', `/chat/${encodeURIComponent(guid)}/unread`);
  }

  updateChat(guid: string, displayName: string) {
    return this.request('PUT', `/chat/${encodeURIComponent(guid)}`, { body: { displayName } });
  }

  deleteChat(guid: string) {
    return this.request('DELETE', `/chat/${encodeURIComponent(guid)}`);
  }

  createChat(addresses: string[], service: "iMessage" | "SMS" = "iMessage") {
    return this.request('POST', '/chat/new', {
      body: { addresses, service },
    });
  }

  addParticipant(chatGuid: string, address: string) {
    return this.request('POST', `/chat/${encodeURIComponent(chatGuid)}/participant/add`, {
      body: { address },
    });
  }

  removeParticipant(chatGuid: string, address: string) {
    return this.request('POST', `/chat/${encodeURIComponent(chatGuid)}/participant/remove`, {
      body: { address },
    });
  }

  leaveChat(chatGuid: string) {
    return this.request('POST', `/chat/${encodeURIComponent(chatGuid)}/leave`);
  }

  getChatIcon(chatGuid: string): Promise<Blob> {
    return this.request('GET', `/chat/${encodeURIComponent(chatGuid)}/icon`, {
      responseType: 'blob',
    });
  }

  setChatIcon(chatGuid: string, file: File) {
    const formData = new FormData();
    formData.append('icon', file);
    return this.request('POST', `/chat/${encodeURIComponent(chatGuid)}/icon`, {
      body: formData,
    });
  }

  deleteChatIcon(chatGuid: string) {
    return this.request('DELETE', `/chat/${encodeURIComponent(chatGuid)}/icon`);
  }

  // ─── Messages ────────────────────────────────────────
  queryMessages(opts: {
    withQuery?: string[];
    where?: any[];
    sort?: string;
    before?: number;
    after?: number;
    chatGuid?: string;
    offset?: number;
    limit?: number;
  } = {}) {
    return this.request('POST', '/message/query', {
      body: {
        with: opts.withQuery ?? ['chats', 'chats.participants', 'attachments', 'attributedBody', 'messageSummaryInfo', 'payloadData'],
        where: opts.where ?? [],
        sort: opts.sort ?? 'DESC',
        before: opts.before,
        after: opts.after,
        chatGuid: opts.chatGuid,
        offset: opts.offset ?? 0,
        limit: opts.limit ?? 100,
        convertAttachments: true,
      },
    });
  }

  messageCount(opts: { after?: number; before?: number } = {}) {
    return this.request('GET', '/message/count', { query: { after: opts.after, before: opts.before } });
  }

  sendText(chatGuid: string, tempGuid: string, message: string, opts: {
    method?: string;
    effectId?: string;
    subject?: string;
    selectedMessageGuid?: string;
    partIndex?: number;
  } = {}) {
    return this.request('POST', '/message/text', {
      body: {
        chatGuid,
        tempGuid,
        message: message || (opts.subject ? ' ' : ''),
        method: opts.method ?? 'private-api',
        effectId: opts.effectId,
        subject: opts.subject,
        selectedMessageGuid: opts.selectedMessageGuid,
        partIndex: opts.partIndex,
      },
      timeoutMs: 60_000,
    });
  }

  sendAttachment(chatGuid: string, tempGuid: string, file: File, opts: { message?: string } = {}) {
    const formData = new FormData();
    formData.append('chatGuid', chatGuid);
    formData.append('tempGuid', tempGuid);
    if (opts.message) formData.append('message', opts.message);
    formData.append('attachment', file);
    return this.request('POST', '/message/attachment', {
      body: formData,
      timeoutMs: 120_000,
    });
  }

  sendReaction(chatGuid: string, selectedMessageText: string, selectedMessageGuid: string, reaction: string, partIndex?: number) {
    return this.request('POST', '/message/react', {
      body: { chatGuid, selectedMessageText, selectedMessageGuid, reaction, partIndex },
    });
  }

  // ─── Handles ─────────────────────────────────────────
  queryHandles(opts: { withQuery?: string[]; address?: string; offset?: number; limit?: number } = {}) {
    return this.request('POST', '/handle/query', {
      body: { with: opts.withQuery, address: opts.address, offset: opts.offset ?? 0, limit: opts.limit ?? 100 },
    });
  }

  // ─── Attachments ─────────────────────────────────────
  downloadAttachment(guid: string, signal?: AbortSignal): Promise<Blob> {
    return this.request('GET', `/attachment/${encodeURIComponent(guid)}/download`, {
      responseType: 'blob',
      signal,
    });
  }

  attachmentBlurhash(guid: string, opts: { height?: number; width?: number; quality?: number } = {}) {
    return this.request('GET', `/attachment/${encodeURIComponent(guid)}/blurhash`, {
      query: { height: opts.height, width: opts.width, quality: opts.quality },
    });
  }

  // ─── Contacts ────────────────────────────────────────
  getContacts() {
    return this.request('GET', '/contact');
  }

  // ─── FCM ─────────────────────────────────────────────
  fcmClient() {
    return this.request('GET', '/fcm/client');
  }
}

export const http = new HttpService();

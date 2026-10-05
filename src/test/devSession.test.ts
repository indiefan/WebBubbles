// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'child_process';
import { GET } from '@/app/api/dev-session/route';
import { HttpService } from '@/services/http';
import { isWriteRequest } from '@/services/devSession';

vi.mock('child_process', () => ({ execFile: vi.fn() }));

const KEYCHAIN: Record<string, string> = {
  'server-url': 'https://bb.example.test',
  password: 'hunter2',
};

/** Make the mocked `security` tool answer from the given items. */
function stubKeychain(items: Record<string, string>) {
  vi.mocked(execFile).mockImplementation(((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
    const account = args[args.indexOf('-a') + 1];
    if (account in items) cb(null, `${items[account]}\n`);
    else cb(new Error('The specified item could not be found in the keychain.'), '');
  }) as never);
}

function request(headers: Record<string, string> = {}) {
  return new Request('http://localhost:3000/api/dev-session', {
    headers: { host: 'localhost:3000', 'sec-fetch-site': 'same-origin', ...headers },
  });
}

// ─── Dev session route ─────────────────────────────────

describe('GET /api/dev-session', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('BB_DEV_SESSION', '1');
    stubKeychain(KEYCHAIN);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(execFile).mockReset();
  });

  it('returns the keychain credentials to the dev build', async () => {
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ serverUrl: 'https://bb.example.test', password: 'hunter2' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('is disabled in production builds', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const res = await GET(request());
    expect(res.status).toBe(404);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('is disabled unless started through npm run dev', async () => {
    vi.stubEnv('BB_DEV_SESSION', '');
    const res = await GET(request());
    expect(res.status).toBe(404);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('refuses requests that are not addressed to loopback', async () => {
    const res = await GET(request({ host: '192.168.1.20:3000' }));
    expect(res.status).toBe(404);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('refuses requests made by another site', async () => {
    const res = await GET(request({ 'sec-fetch-site': 'cross-site' }));
    expect(res.status).toBe(404);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('returns 404 when the keychain has no saved sign-in', async () => {
    stubKeychain({ 'server-url': KEYCHAIN['server-url'] });
    const res = await GET(request());
    expect(res.status).toBe(404);
    expect(await res.json()).not.toHaveProperty('serverUrl');
  });
});

// ─── Read-only guard ───────────────────────────────────

describe('read-only mode', () => {
  it('treats GETs and query POSTs as reads, everything else as a write', () => {
    expect(isWriteRequest('GET', '/chat/abc/message')).toBe(false);
    expect(isWriteRequest('POST', '/chat/query')).toBe(false);
    expect(isWriteRequest('POST', '/message/query')).toBe(false);

    expect(isWriteRequest('POST', '/chat/abc/read')).toBe(true);
    expect(isWriteRequest('POST', '/message/text')).toBe(true);
    expect(isWriteRequest('POST', '/message/react')).toBe(true);
    expect(isWriteRequest('PUT', '/chat/abc')).toBe(true);
    expect(isWriteRequest('DELETE', '/chat/abc')).toBe(true);
  });

  describe('HttpService', () => {
    let http: HttpService;
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchSpy = vi.fn(async () => new Response(JSON.stringify({ status: 200, data: [] })));
      vi.stubGlobal('fetch', fetchSpy);
      http = new HttpService();
      http.configure('https://bb.example.test', 'hunter2');
      http.readOnly = true;
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('blocks sends, reactions and read receipts before they reach the network', async () => {
      await expect(http.sendText('chat-1', 'temp-1', 'hello')).rejects.toThrow(/Read-only/);
      await expect(http.sendReaction('chat-1', 'hi', 'msg-1', 'love')).rejects.toThrow(/Read-only/);
      await expect(http.markChatRead('chat-1')).rejects.toThrow(/Read-only/);
      await expect(http.unsendMessage('msg-1')).rejects.toThrow(/Read-only/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('still allows reads and queries', async () => {
      await http.chatMessages('chat-1');
      await http.queryChats();
      await http.queryMessages();
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('is off by default outside dev builds', () => {
      expect(new HttpService().readOnly).toBe(false);
    });
  });
});

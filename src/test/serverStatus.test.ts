// Server status: health, alerts, and the restart actions.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { http } from '@/services/http';
import { isWriteRequest } from '@/services/devSession';
import { describeError, markAlertsRead, refreshServerStatus, runServerAction, stopServerMonitor, timing } from '@/services/serverStatus';
import { deriveHealth, ServerInfo, useServerStatusStore } from '@/stores/serverStatusStore';
import { useConnectionStore } from '@/stores/connectionStore';

vi.mock('@/services/sync', () => ({ resync: vi.fn().mockResolvedValue(undefined) }));

const HEALTHY: ServerInfo = { version: '1.9.9', osVersion: '26.0.1', privateApiEnabled: true, helperConnected: true };

function serverInfo(overrides: Record<string, unknown> = {}) {
  return { data: { server_version: '1.9.9', os_version: '26.0.1', private_api: true, helper_connected: true, ...overrides } };
}

const original = { ...timing };

beforeEach(() => {
  stopServerMonitor();
  useConnectionStore.setState({ socketState: 'connected' });
  // Restarts poll every few seconds in real life; keep tests quick
  Object.assign(timing, { retryMs: 5, restartStartMs: 50, servicesBackMs: 200, relaunchBackMs: 200, updateBackMs: 200, helperBackMs: 100, socketBackMs: 50 });
  vi.spyOn(http, 'serverInfo').mockResolvedValue(serverInfo());
  vi.spyOn(http, 'serverAlerts').mockResolvedValue({ data: [] });
  vi.spyOn(http, 'checkForServerUpdate').mockResolvedValue({ data: { available: false, current: '1.9.9', metadata: null } });
  vi.spyOn(http, 'ping').mockResolvedValue({ data: 'pong' });
});

afterEach(() => {
  Object.assign(timing, original);
  vi.restoreAllMocks();
});

// ─── Health ────────────────────────────────────────────

describe('health', () => {
  const base = { socketState: 'connected' as const, info: HEALTHY, unreachable: false, action: null };

  it('is fine when connected and the helper is up', () => {
    expect(deriveHealth(base).level).toBe('ok');
  });

  it('warns that sending is broken when the Messages helper drops', () => {
    const health = deriveHealth({ ...base, info: { ...HEALTHY, helperConnected: false } });
    expect(health.level).toBe('degraded');
    expect(health.detail).toMatch(/won’t send/);
    expect(health.fixable).toBe(true);
  });

  it('does not count the helper when the Private API is turned off', () => {
    expect(deriveHealth({ ...base, info: { ...HEALTHY, privateApiEnabled: false, helperConnected: false } }).level).toBe('ok');
  });

  it('distinguishes reconnecting, disconnected and unreachable', () => {
    expect(deriveHealth({ ...base, socketState: 'connecting' }).level).toBe('busy');
    expect(deriveHealth({ ...base, socketState: 'disconnected' })).toMatchObject({ level: 'down', fixable: true });
    // If the server can't be reached at all, a restart request can't reach it either
    expect(deriveHealth({ ...base, socketState: 'error', unreachable: true })).toMatchObject({ level: 'down', fixable: false });
  });

  it('shows a running restart instead of the problem it is fixing', () => {
    const action = { kind: 'restart-services' as const, phase: 'running' as const, message: '', finishedAt: null };
    expect(deriveHealth({ ...base, socketState: 'disconnected', action })).toMatchObject({ level: 'busy', summary: 'Restarting the server…' });
  });
});

// ─── Reading status ────────────────────────────────────

describe('refreshing status', () => {
  it('reads info, alerts and update availability', async () => {
    vi.mocked(http.serverInfo).mockResolvedValue(serverInfo({ helper_connected: false }));
    vi.mocked(http.serverAlerts).mockResolvedValue({
      data: [{ id: 7, type: 'error', value: 'Command failed: sips', isRead: false, created: '2026-09-01T10:00:00.000Z' }],
    });
    vi.mocked(http.checkForServerUpdate).mockResolvedValue({ data: { available: true, metadata: { version: '1.10.0' } } });

    await refreshServerStatus();

    const state = useServerStatusStore.getState();
    expect(state.info).toEqual({ ...HEALTHY, helperConnected: false });
    expect(state.alerts).toEqual([
      { id: 7, type: 'error', message: 'Command failed: sips', isRead: false, created: Date.parse('2026-09-01T10:00:00.000Z') },
    ]);
    expect(state.update).toMatchObject({ available: true, version: '1.10.0' });
  });

  it('remembers what it last knew when the server stops answering', async () => {
    await refreshServerStatus();
    vi.mocked(http.serverInfo).mockRejectedValue(new Error('Failed to fetch'));

    await refreshServerStatus();

    expect(useServerStatusStore.getState()).toMatchObject({ info: HEALTHY, unreachable: true });
  });

  it('checks GitHub for updates only every few hours unless asked', async () => {
    await refreshServerStatus();
    await refreshServerStatus();
    expect(http.checkForServerUpdate).toHaveBeenCalledTimes(1);

    await refreshServerStatus({ forceUpdateCheck: true });
    expect(http.checkForServerUpdate).toHaveBeenCalledTimes(2);
  });

  it('marks alerts read on the server and locally', async () => {
    vi.mocked(http.serverAlerts).mockResolvedValue({
      data: [
        { id: 1, type: 'error', value: 'a', isRead: false },
        { id: 2, type: 'info', value: 'b', isRead: false },
      ],
    });
    const markRead = vi.spyOn(http, 'markAlertsRead').mockResolvedValue({ data: null });
    await refreshServerStatus();

    await markAlertsRead([1, 2]);

    expect(markRead).toHaveBeenCalledWith([1, 2]);
    expect(useServerStatusStore.getState().alerts.every((a) => a.isRead)).toBe(true);
  });
});

// ─── Fixes ─────────────────────────────────────────────

describe('restart actions', () => {
  it('restarts Messages and waits for the helper to reconnect', async () => {
    const restart = vi.spyOn(http, 'restartMessagesApp').mockResolvedValue({});
    vi.mocked(http.serverInfo)
      .mockResolvedValueOnce(serverInfo({ helper_connected: false }))
      .mockResolvedValue(serverInfo());

    await runServerAction('restart-messages');

    expect(restart).toHaveBeenCalledOnce();
    expect(useServerStatusStore.getState().action).toMatchObject({ phase: 'done', message: 'Messages restarted.' });
  });

  it('says so when Messages restarted but the helper stayed away', async () => {
    vi.spyOn(http, 'restartMessagesApp').mockResolvedValue({});
    vi.mocked(http.serverInfo).mockResolvedValue(serverInfo({ helper_connected: false }));

    await runServerAction('restart-messages');

    expect(useServerStatusStore.getState().action).toMatchObject({ phase: 'warning' });
    expect(useServerStatusStore.getState().action?.message).toMatch(/hasn’t reconnected/);
  });

  it('restarts the server and waits until it answers again', async () => {
    vi.spyOn(http, 'restartServerServices').mockResolvedValue({});
    // The connection drops, then the server comes back after a few failed pings
    setTimeout(() => useConnectionStore.setState({ socketState: 'disconnected' }), 10);
    vi.mocked(http.ping)
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockImplementation(async () => {
        useConnectionStore.setState({ socketState: 'connected' });
        return { data: 'pong' };
      });

    await runServerAction('restart-services');

    expect(http.ping).toHaveBeenCalledTimes(3);
    expect(useServerStatusStore.getState().action).toMatchObject({ phase: 'done', message: 'Server restarted.' });
  });

  it('reports a server that does not come back', async () => {
    vi.spyOn(http, 'relaunchServer').mockResolvedValue({});
    vi.mocked(http.ping).mockRejectedValue(new Error('Failed to fetch'));

    await runServerAction('relaunch');

    expect(useServerStatusStore.getState().action).toMatchObject({ phase: 'failed' });
    expect(useServerStatusStore.getState().action?.message).toMatch(/hasn’t come back/);
  });

  it('waits for the new version after starting an update', async () => {
    vi.spyOn(http, 'installServerUpdate').mockResolvedValue({});
    await refreshServerStatus();
    vi.mocked(http.serverInfo)
      .mockResolvedValueOnce(serverInfo())
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValue(serverInfo({ server_version: '1.10.0' }));

    await runServerAction('install-update');

    expect(useServerStatusStore.getState().action).toMatchObject({ phase: 'done', message: 'Updated to 1.10.0.' });
  });

  it('shows the server’s reason when a fix fails, and runs one fix at a time', async () => {
    let release: () => void = () => {};
    vi.spyOn(http, 'restartMessagesApp').mockImplementation(
      () =>
        new Promise((_, reject) => {
          release = () =>
            reject(new Error('HTTP 500: {"status":500,"message":"Failed to restart Messages App!","error":{"message":"AppleScript timed out"}}'));
        }),
    );
    const restartServer = vi.spyOn(http, 'restartServerServices');

    const first = runServerAction('restart-messages');
    await runServerAction('restart-services');
    expect(restartServer).not.toHaveBeenCalled();

    release();
    await first;
    expect(useServerStatusStore.getState().action).toMatchObject({ phase: 'failed', message: 'AppleScript timed out' });
  });
});

describe('describeError', () => {
  it('pulls the reason out of a server error', () => {
    expect(describeError(new Error('HTTP 400: {"message":"No update available!"}'))).toBe('No update available!');
    expect(describeError(new Error('HTTP 502: Bad Gateway'))).toBe('HTTP 502: Bad Gateway');
    expect(describeError(new Error('Read-only mode: blocked POST /mac/imessage/restart'))).toMatch(/read-only/);
  });
});

describe('read-only dev builds', () => {
  it('treat the restart GETs as writes', () => {
    expect(isWriteRequest('GET', '/server/restart/soft')).toBe(true);
    expect(isWriteRequest('GET', '/server/restart/hard')).toBe(true);
    expect(isWriteRequest('POST', '/mac/imessage/restart')).toBe(true);
    expect(isWriteRequest('POST', '/server/alert/read')).toBe(true);
    // Reading status is fine
    expect(isWriteRequest('GET', '/server/info')).toBe(false);
    expect(isWriteRequest('GET', '/server/alert')).toBe(false);
    expect(isWriteRequest('GET', '/server/update/check')).toBe(false);
  });
});

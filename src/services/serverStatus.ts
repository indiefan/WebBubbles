// Server status: what state the BlueBubbles server is in, and the restarts
// that fix the usual problems without a trip to the Mac running it.

import { http } from './http';
import { socketService } from './socket';
import { resync } from './sync';
import { useConnectionStore } from '@/stores/connectionStore';
import {
  ServerActionKind,
  ServerAlert,
  ServerInfo,
  useServerStatusStore,
} from '@/stores/serverStatusStore';

/** Timings, exported so tests can shorten them. */
export const timing = {
  /** How often status is re-read while the app is visible. */
  pollMs: 5 * 60_000,
  /** Status isn't re-read on tab focus more often than this. */
  focusThrottleMs: 30_000,
  /** Update checks go to GitHub, so they're rare. */
  updateCheckMs: 6 * 3600_000,
  /** Between attempts while waiting for the server to come back. */
  retryMs: 2_000,
  /**
   * The server answers a restart request before restarting. Wait this long to
   * see the connection drop, so the old process isn't mistaken for the new one.
   */
  restartStartMs: 15_000,
  /** How long to wait for the server after each kind of restart. */
  servicesBackMs: 90_000,
  relaunchBackMs: 3 * 60_000,
  updateBackMs: 15 * 60_000,
  helperBackMs: 30_000,
  socketBackMs: 20_000,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Reading status ────────────────────────────────────

function toInfo(data: any): ServerInfo {
  return {
    version: data?.server_version ?? null,
    osVersion: data?.os_version ?? null,
    privateApiEnabled: !!data?.private_api,
    helperConnected: !!data?.helper_connected,
  };
}

function toAlert(data: any): ServerAlert {
  const created = data?.created ? new Date(data.created).getTime() : NaN;
  return {
    id: Number(data?.id),
    type: data?.type ?? 'info',
    message: String(data?.value ?? data?.message ?? ''),
    isRead: !!data?.isRead,
    created: Number.isFinite(created) ? created : null,
  };
}

async function readInfo(): Promise<ServerInfo | null> {
  try {
    const res = await http.serverInfo();
    const info = toInfo(res?.data);
    useServerStatusStore.getState().setInfo(info, false);
    return info;
  } catch {
    useServerStatusStore.getState().setInfo(null, true);
    return null;
  }
}

async function readAlerts() {
  try {
    const res = await http.serverAlerts();
    useServerStatusStore.getState().setAlerts((res?.data ?? []).map(toAlert).filter((a: ServerAlert) => a.id));
  } catch {
    // Alerts are informational; keep the last ones we had
  }
}

async function readUpdate(force: boolean) {
  const last = useServerStatusStore.getState().update;
  if (!force && last && Date.now() - last.checkedAt < timing.updateCheckMs) return;
  try {
    const res = await http.checkForServerUpdate();
    useServerStatusStore.getState().setUpdate({
      available: !!res?.data?.available,
      version: res?.data?.metadata?.version ?? null,
      checkedAt: Date.now(),
    });
  } catch {
    // The server couldn't reach GitHub; try again next time
  }
}

let refreshInFlight: Promise<void> | null = null;

/**
 * Re-read the server's status and alerts, and check for an update when one
 * hasn't been checked for a while (or `forceUpdateCheck`).
 */
export function refreshServerStatus(opts: { forceUpdateCheck?: boolean } = {}): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  const run: Promise<void> = Promise.all([readInfo(), readAlerts(), readUpdate(!!opts.forceUpdateCheck)])
    .then(() => undefined)
    .finally(() => {
      if (refreshInFlight === run) refreshInFlight = null;
    });
  refreshInFlight = run;
  return run;
}

export async function markAlertsRead(ids: number[]) {
  if (ids.length === 0) return;
  await http.markAlertsRead(ids);
  const { alerts, setAlerts } = useServerStatusStore.getState();
  setAlerts(alerts.map((a) => (ids.includes(a.id) ? { ...a, isRead: true } : a)));
}

// ─── Monitoring ────────────────────────────────────────

let monitoring = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastFocusRefresh = 0;

function onConnect() {
  void refreshServerStatus();
}

function onVisible() {
  if (document.visibilityState !== 'visible') return;
  if (Date.now() - lastFocusRefresh < timing.focusThrottleMs) return;
  lastFocusRefresh = Date.now();
  void refreshServerStatus();
}

/** Keep server status current: on connect, on tab focus, and every few minutes. */
export function startServerMonitor() {
  if (monitoring || typeof window === 'undefined') return;
  monitoring = true;
  socketService.on('connect', onConnect);
  document.addEventListener('visibilitychange', onVisible);
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') void refreshServerStatus();
  }, timing.pollMs);
  void refreshServerStatus();
}

export function stopServerMonitor() {
  if (monitoring) {
    socketService.off('connect', onConnect);
    document.removeEventListener('visibilitychange', onVisible);
  }
  monitoring = false;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  refreshInFlight = null;
  lastFocusRefresh = 0;
  useServerStatusStore.getState().reset();
}

// ─── Fixes ─────────────────────────────────────────────

/** A readable reason from a failed request ("HTTP 500: {json}" → its message). */
export function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.startsWith('Read-only mode')) return 'Not available in the read-only dev build.';
  const match = raw.match(/^HTTP \d+: ([\s\S]*)$/);
  if (match) {
    try {
      const body = JSON.parse(match[1]);
      const detail = body?.error?.message ?? body?.error?.error ?? body?.message;
      if (detail) return String(detail);
    } catch {
      // Not JSON: fall through to the raw text
    }
  }
  return raw;
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(timing.retryMs);
  }
}

async function serverAnswers(): Promise<boolean> {
  try {
    await http.ping({ timeoutMs: 4_000 });
    return true;
  } catch {
    return false;
  }
}

/** After a restart: wait for the server, then for the socket, then catch up on anything missed. */
async function waitForServerBack(timeoutMs: number): Promise<boolean> {
  await waitFor(() => useConnectionStore.getState().socketState !== 'connected', timing.restartStartMs);
  if (!(await waitFor(serverAnswers, timeoutMs))) return false;

  socketService.ensureConnected();
  await waitFor(() => useConnectionStore.getState().socketState === 'connected', timing.socketBackMs);
  void resync();
  await refreshServerStatus();
  return true;
}

function finish(kind: ServerActionKind, phase: 'done' | 'warning' | 'failed', message: string) {
  useServerStatusStore.getState().setAction({ kind, phase, message, finishedAt: Date.now() });
}

const RUNNING_MESSAGES: Record<ServerActionKind, string> = {
  'restart-messages': 'Restarting Messages…',
  'restart-services': 'Restarting the server…',
  relaunch: 'Relaunching the server app…',
  'install-update': 'Downloading the update…',
};

/** Run one of the restart actions. Only one runs at a time. */
export async function runServerAction(kind: ServerActionKind): Promise<void> {
  const store = useServerStatusStore.getState();
  if (store.action?.phase === 'running') return;
  store.setAction({ kind, phase: 'running', message: RUNNING_MESSAGES[kind], finishedAt: null });

  try {
    switch (kind) {
      case 'restart-messages': {
        // Answers once Messages is back up
        await http.restartMessagesApp();
        const helperBack = await waitFor(async () => {
          const info = await readInfo();
          return !info?.privateApiEnabled || info.helperConnected;
        }, timing.helperBackMs);
        if (helperBack) finish(kind, 'done', 'Messages restarted.');
        else finish(kind, 'warning', 'Messages restarted, but its helper hasn’t reconnected yet. Try restarting the server.');
        break;
      }

      case 'restart-services':
      case 'relaunch': {
        if (kind === 'restart-services') await http.restartServerServices();
        else await http.relaunchServer();
        const back = await waitForServerBack(kind === 'relaunch' ? timing.relaunchBackMs : timing.servicesBackMs);
        if (back) finish(kind, 'done', kind === 'relaunch' ? 'Server app relaunched.' : 'Server restarted.');
        else finish(kind, 'failed', 'The server hasn’t come back yet. It may need attention on the Mac.');
        break;
      }

      case 'install-update': {
        const from = useServerStatusStore.getState().info?.version ?? null;
        await http.installServerUpdate();
        useServerStatusStore.getState().setAction({ kind, phase: 'running', message: 'Installing the update…', finishedAt: null });
        // The server downloads, installs and relaunches itself; wait for the new version to answer
        const updated = await waitFor(async () => {
          const info = await readInfo();
          return !!info?.version && info.version !== from;
        }, timing.updateBackMs);
        if (updated) {
          socketService.ensureConnected();
          void resync();
          await refreshServerStatus({ forceUpdateCheck: true });
          finish(kind, 'done', `Updated to ${useServerStatusStore.getState().info?.version}.`);
        } else {
          finish(kind, 'warning', 'The update hasn’t finished yet. Check back in a few minutes.');
        }
        break;
      }
    }
  } catch (err) {
    finish(kind, 'failed', describeError(err));
  }
}

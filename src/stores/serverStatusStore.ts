import { create } from 'zustand';
import type { SocketState } from './connectionStore';

export interface ServerInfo {
  version: string | null;
  osVersion: string | null;
  privateApiEnabled: boolean;
  /** The Private API helper inside Messages is connected. Sending depends on it. */
  helperConnected: boolean;
}

export interface ServerAlert {
  id: number;
  type: string;
  message: string;
  isRead: boolean;
  created: number | null;
}

export interface ServerUpdate {
  available: boolean;
  version: string | null;
  checkedAt: number;
}

export type ServerActionKind = 'restart-messages' | 'restart-services' | 'relaunch' | 'install-update';

export interface ServerActionState {
  kind: ServerActionKind;
  phase: 'running' | 'done' | 'warning' | 'failed';
  message: string;
  finishedAt: number | null;
}

interface ServerStatusState {
  info: ServerInfo | null;
  /** The last attempt to read the server's status failed. */
  unreachable: boolean;
  checkedAt: number | null;
  alerts: ServerAlert[];
  update: ServerUpdate | null;
  action: ServerActionState | null;

  setInfo: (info: ServerInfo | null, unreachable: boolean) => void;
  setAlerts: (alerts: ServerAlert[]) => void;
  setUpdate: (update: ServerUpdate) => void;
  setAction: (action: ServerActionState | null) => void;
  reset: () => void;
}

const initial = {
  info: null,
  unreachable: false,
  checkedAt: null,
  alerts: [],
  update: null,
  action: null,
};

export const useServerStatusStore = create<ServerStatusState>((set) => ({
  ...initial,

  setInfo: (info, unreachable) =>
    set((s) => ({ info: info ?? s.info, unreachable, checkedAt: unreachable ? s.checkedAt : Date.now() })),
  setAlerts: (alerts) => set({ alerts }),
  setUpdate: (update) => set({ update }),
  setAction: (action) => set({ action }),
  reset: () => set(initial),
}));

// ─── Health ────────────────────────────────────────────

export type HealthLevel = 'ok' | 'busy' | 'degraded' | 'down';

export interface Health {
  level: HealthLevel;
  /** A few words for the indicator's tooltip and the panel heading. */
  summary: string;
  /** What it means for the user, when something is wrong. */
  detail: string | null;
  /** The problem is one of the restart actions can fix. */
  fixable: boolean;
}

const ACTION_LABELS: Record<ServerActionKind, string> = {
  'restart-messages': 'Restarting Messages…',
  'restart-services': 'Restarting the server…',
  relaunch: 'Relaunching the server app…',
  'install-update': 'Updating the server…',
};

/** Overall state of the connection to the server, worst problem first. */
export function deriveHealth(input: {
  socketState: SocketState;
  info: ServerInfo | null;
  unreachable: boolean;
  action: ServerActionState | null;
}): Health {
  const { socketState, info, unreachable, action } = input;

  if (action?.phase === 'running') {
    return { level: 'busy', summary: ACTION_LABELS[action.kind], detail: null, fixable: false };
  }

  if (socketState !== 'connected') {
    if (unreachable) {
      return {
        level: 'down',
        summary: 'Can’t reach the server',
        detail: 'New messages won’t arrive and nothing can be sent until it’s back.',
        fixable: false,
      };
    }
    if (socketState === 'connecting') {
      return { level: 'busy', summary: 'Reconnecting…', detail: null, fixable: false };
    }
    return {
      level: 'down',
      summary: 'Disconnected from the server',
      detail: 'New messages won’t arrive until the connection is back.',
      fixable: true,
    };
  }

  if (info?.privateApiEnabled && !info.helperConnected) {
    return {
      level: 'degraded',
      summary: 'Messages helper disconnected',
      detail: 'Messages won’t send, and reactions, edits and typing won’t work. Restarting Messages usually fixes it.',
      fixable: true,
    };
  }

  return { level: 'ok', summary: 'Connected', detail: null, fixable: false };
}

import { create } from 'zustand';

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'complete';

interface SyncState {
  status: SyncStatus;
  progress: number; // 0-100
  currentLabel: string;
  lastFullSync: number | null;
  lastIncrementalSync: number | null;
  lastIncrementalSyncRowId: number | null;

  setStatus: (status: SyncStatus) => void;
  setProgress: (progress: number, label?: string) => void;
  setLastFullSync: (ts: number) => void;
  setLastIncrementalSync: (ts: number, rowId?: number) => void;
  reset: () => void;
}

export const useSyncStore = create<SyncState>((set) => {
  const lfs = typeof window !== 'undefined' ? localStorage.getItem('bb-last-full-sync') : null;
  const lis = typeof window !== 'undefined' ? localStorage.getItem('bb-last-inc-sync') : null;
  const lisr = typeof window !== 'undefined' ? localStorage.getItem('bb-last-inc-sync-rowid') : null;

  return {
    status: 'idle',
    progress: 0,
    currentLabel: '',
    lastFullSync: lfs ? Number(lfs) : null,
    lastIncrementalSync: lis ? Number(lis) : null,
    lastIncrementalSyncRowId: lisr ? Number(lisr) : null,

    setStatus: (status) => set({ status }),
    setProgress: (progress, label) => set((s) => ({ progress, currentLabel: label ?? s.currentLabel })),

    setLastFullSync: (ts) => {
      if (typeof window !== 'undefined') localStorage.setItem('bb-last-full-sync', String(ts));
      set({ lastFullSync: ts });
    },

    setLastIncrementalSync: (ts, rowId) => {
      if (typeof window !== 'undefined') {
        localStorage.setItem('bb-last-inc-sync', String(ts));
        if (rowId !== undefined) localStorage.setItem('bb-last-inc-sync-rowid', String(rowId));
      }
      set((s) => ({
        lastIncrementalSync: ts,
        lastIncrementalSyncRowId: rowId ?? s.lastIncrementalSyncRowId,
      }));
    },

    reset: () => set({ status: 'idle', progress: 0, currentLabel: '' }),
  };
});

import { create } from 'zustand';

interface DownloadState {
  progress: Record<string, number>;
  loading: Record<string, boolean>;
  setProgress: (guid: string, progress: number) => void;
  setLoading: (guid: string, isLoading: boolean) => void;
}

export const useDownloadStore = create<DownloadState>((set) => ({
  progress: {},
  loading: {},
  setProgress: (guid, progress) => set((s) => ({ progress: { ...s.progress, [guid]: progress } })),
  setLoading: (guid, isLoading) => set((s) => ({ loading: { ...s.loading, [guid]: isLoading } })),
}));

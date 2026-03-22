import { create } from 'zustand';

export type SocketState = 'connected' | 'disconnected' | 'connecting' | 'error';

interface ConnectionState {
  serverAddress: string;
  password: string;
  socketState: SocketState;
  lastError: string;
  serverVersion: string | null;
  privateAPIEnabled: boolean;
  isSetup: boolean;

  // Actions
  setCredentials: (serverAddress: string, password: string) => void;
  setSocketState: (state: SocketState) => void;
  setLastError: (error: string) => void;
  setServerInfo: (info: { version?: string; privateAPI?: boolean }) => void;
  clear: () => void;
}

export const useConnectionStore = create<ConnectionState>((set) => {
  // Hydrate from localStorage on init
  const saved = typeof window !== 'undefined'
    ? { url: localStorage.getItem('bb-server-url') || '', pw: localStorage.getItem('bb-server-password') || '' }
    : { url: '', pw: '' };

  return {
    serverAddress: saved.url,
    password: saved.pw,
    socketState: 'disconnected',
    lastError: '',
    serverVersion: null,
    privateAPIEnabled: false,
    isSetup: !!saved.url && !!saved.pw,

    setCredentials: (serverAddress, password) => {
      if (typeof window !== 'undefined') {
        localStorage.setItem('bb-server-url', serverAddress);
        localStorage.setItem('bb-server-password', password);
      }
      set({ serverAddress, password, isSetup: true });
    },

    setSocketState: (socketState) => set({ socketState }),
    setLastError: (lastError) => set({ lastError }),
    setServerInfo: (info) =>
      set((s) => ({
        serverVersion: info.version ?? s.serverVersion,
        privateAPIEnabled: info.privateAPI ?? s.privateAPIEnabled,
      })),
    clear: () => {
      if (typeof window !== 'undefined') {
        localStorage.removeItem('bb-server-url');
        localStorage.removeItem('bb-server-password');
      }
      set({
        serverAddress: '',
        password: '',
        socketState: 'disconnected',
        lastError: '',
        serverVersion: null,
        privateAPIEnabled: false,
        isSetup: false,
      });
    },
  };
});

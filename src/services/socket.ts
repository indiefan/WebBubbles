// Socket.IO service for real-time events from the BlueBubbles server.

import { io, Socket } from 'socket.io-client';
import { useConnectionStore, SocketState } from '@/stores/connectionStore';

export type SocketEventHandler = (data: any) => void;

export class SocketService {
  private socket: Socket | null = null;
  private handlers = new Map<string, Set<SocketEventHandler>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  connect(serverAddress: string, password: string) {
    this.disconnect();

    this.socket = io(serverAddress, {
      query: { guid: password },
      transports: ['websocket', 'polling'],
      autoConnect: true,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    this.socket.on('connect', () => {
      console.log('[Socket] Connected');
      this.setSocketState('connected');
    });

    this.socket.on('disconnect', (reason) => {
      console.log('[Socket] Disconnected:', reason);
      this.setSocketState('disconnected');
    });

    this.socket.on('connect_error', (err) => {
      console.error('[Socket] Connection error:', err.message);
      useConnectionStore.getState().setLastError(err.message);
      this.setSocketState('error');
    });

    this.socket.io.on('reconnect_attempt', () => {
      this.setSocketState('connecting');
    });

    // Register all event handlers
    const events = [
      'new-message',
      'updated-message',
      'typing-indicator',
      'chat-read-status-changed',
      'group-name-change',
      'participant-added',
      'participant-removed',
      'participant-left',
      'ft-call-status-changed',
      'incoming-facetime',
      'imessage-aliases-removed',
    ];

    for (const event of events) {
      this.socket.on(event, (data: any) => {
        console.log(`[Socket] Event: ${event}`, data);
        this.emit(event, data);
      });
    }
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  on(event: string, handler: SocketEventHandler) {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
  }

  off(event: string, handler: SocketEventHandler) {
    this.handlers.get(event)?.delete(handler);
  }

  private emit(event: string, data: any) {
    this.handlers.get(event)?.forEach((h) => h(data));
  }

  private setSocketState(state: SocketState) {
    useConnectionStore.getState().setSocketState(state);
  }

  /** Emit an event to the server (e.g. typing indicators). */
  sendEvent(event: string, data: any) {
    if (this.socket?.connected) {
      this.socket.emit(event, data);
    }
  }

  get isConnected() {
    return this.socket?.connected ?? false;
  }
}

export const socketService = new SocketService();

import { io, Socket } from 'socket.io-client';

// WebSocket event types matching server
export interface SocketEvents {
  // Client -> Server
  'join-location': (locationId: string) => void;
  'leave-location': (locationId: string) => void;
  
  // Server -> Client
  'risk-state-change': (data: {
    locationId: string;
    locationName: string;
    newState: string;
    previousState: string | null;
    reason: string;
    evaluatedAt: string;
    flashesInStopRadius: number;
    flashesInPrepareRadius: number;
    nearestFlashKm: number | null;
    isDegraded: boolean;
  }) => void;
  
  'alert-triggered': (data: {
    locationId: string;
    locationName: string;
    alertType: string;
    state: string;
    reason: string;
    timestamp: string;
  }) => void;
  
  'system-health': (data: {
    feedHealthy: boolean;
    dataAgeMinutes: number | null;
    flashCount: number;
    locationCount: number;
    lastIngestion: string | null;
  }) => void;
  
  'error': (error: { message: string; code?: string }) => void;
}

class WebSocketService {
  private socket: Socket<SocketEvents, SocketEvents> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;

  connect(token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket?.connected) {
        resolve();
        return;
      }

      this.socket = io('http://localhost:3001', {
        auth: { token },
        transports: ['websocket', 'polling'],
      });

      this.socket.on('connect', () => {
        console.log('WebSocket connected');
        this.reconnectAttempts = 0;
        resolve();
      });

      this.socket.on('disconnect', (reason: string) => {
        console.log('WebSocket disconnected:', reason);
        if (reason === 'io server disconnect') {
          // Server initiated disconnect, need to reconnect manually
          this.connect(token);
        }
      });

      this.socket.on('connect_error', (error: Error) => {
        console.error('WebSocket connection error:', error);
        this.reconnectAttempts++;
        
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          setTimeout(() => {
            this.connect(token);
          }, this.reconnectDelay * Math.pow(2, this.reconnectAttempts));
        } else {
          reject(error);
        }
      });
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  joinLocation(locationId: string): void {
    if (this.socket?.connected) {
      this.socket.emit('join-location', locationId);
    }
  }

  leaveLocation(locationId: string): void {
    if (this.socket?.connected) {
      this.socket.emit('leave-location', locationId);
    }
  }

  onRiskStateChange(callback: (data: Parameters<SocketEvents['risk-state-change']>[0]) => void): void {
    if (this.socket) {
      this.socket.on('risk-state-change', callback);
    }
  }

  onAlertTriggered(callback: (data: Parameters<SocketEvents['alert-triggered']>[0]) => void): void {
    if (this.socket) {
      this.socket.on('alert-triggered', callback);
    }
  }

  onSystemHealth(callback: (data: Parameters<SocketEvents['system-health']>[0]) => void): void {
    if (this.socket) {
      this.socket.on('system-health', callback);
    }
  }

  onError(callback: (error: Parameters<SocketEvents['error']>[0]) => void): void {
    if (this.socket) {
      this.socket.on('error', callback);
    }
  }

  offRiskStateChange(callback: (data: Parameters<SocketEvents['risk-state-change']>[0]) => void): void {
    if (this.socket) {
      this.socket.off('risk-state-change', callback);
    }
  }

  offAlertTriggered(callback: (data: Parameters<SocketEvents['alert-triggered']>[0]) => void): void {
    if (this.socket) {
      this.socket.off('alert-triggered', callback);
    }
  }

  offSystemHealth(callback: (data: Parameters<SocketEvents['system-health']>[0]) => void): void {
    if (this.socket) {
      this.socket.off('system-health', callback);
    }
  }

  offError(callback: (error: Parameters<SocketEvents['error']>[0]) => void): void {
    if (this.socket) {
      this.socket.off('error', callback);
    }
  }

  isConnected(): boolean {
    return this.socket?.connected || false;
  }
}

export const wsService = new WebSocketService();
export default wsService;

import { Server as HTTPServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { logger } from './logger';

// Extend Socket's data property to carry auth info
interface SocketData {
  userId: string;
  userEmail: string;
  userRole: string;
}

type AuthenticatedSocket = Socket & { data: SocketData };

// Payload broadcast to clients when an alert is triggered.
// Mirrored client-side in `client/src/useRealtimeAlerts.ts` (RealtimeAlert).
export interface WsAlertPayload {
  locationId: string;
  locationName: string;
  alertType: string;        // 'system' | 'email' | 'sms' | 'whatsapp'
  state: string;            // 'STOP' | 'PREPARE' | 'HOLD' | 'ALL_CLEAR' | 'DEGRADED'
  reason: string;
  timestamp: string;        // ISO
}

// Socket event types
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
  
  'alert-triggered': (data: WsAlertPayload) => void;
  
  'system-health': (data: {
    feedHealthy: boolean;
    dataAgeMinutes: number | null;
    flashCount: number;
    locationCount: number;
    lastIngestion: string | null;
  }) => void;
  
  'error': (error: { message: string; code?: string }) => void;
}

class WebSocketManager {
  private io: SocketIOServer<SocketEvents, SocketEvents> | null = null;
  private connectedClients = new Map<string, AuthenticatedSocket>();
  private locationSubscriptions = new Map<string, Set<string>>(); // locationId -> Set of socketIds

  initialize(server: HTTPServer): void {
    this.io = new SocketIOServer(server, {
      cors: {
        origin: process.env.CORS_ORIGIN || true,
        credentials: true,
      },
      transports: ['websocket', 'polling'],
    });

    // Authentication middleware
    this.io.use(async (socket: any, next: (err?: Error) => void) => {
      try {
        const token = (socket as any).handshake.auth.token || (socket as any).handshake.headers.authorization?.replace('Bearer ', '');
        
        if (!token) {
          return next(new Error('Authentication required'));
        }

        const JWT_SECRET = process.env.JWT_SECRET;
        if (!JWT_SECRET || JWT_SECRET === 'change-me-to-a-random-secret-in-production') {
          logger.error('JWT_SECRET not configured properly');
          return next(new Error('Server configuration error'));
        }

        const decoded = jwt.verify(token, JWT_SECRET) as any;
        socket.data.userId = decoded.id;
        socket.data.userEmail = decoded.email;
        socket.data.userRole = decoded.role;

        logger.info('WebSocket client authenticated', {
          socketId: socket.id,
          userId: socket.data.userId,
          userEmail: socket.data.userEmail,
          userRole: socket.data.userRole,
        });

        next();
      } catch (error) {
        logger.warn('WebSocket authentication failed', { error: (error as Error).message });
        next(new Error('Invalid authentication token'));
      }
    });

    this.io.on('connection', (socket: any) => {
      this.handleConnection(socket);
    });

    logger.info('WebSocket server initialized');
  }

  private handleConnection(socket: Socket): void {
    this.connectedClients.set(socket.id, socket);

    logger.info('Client connected', {
      socketId: socket.id,
      userId: socket.data.userId,
      userEmail: socket.data.userEmail,
      totalClients: this.connectedClients.size,
    });

    // Send welcome message with current system status
    socket.emit('system-health', {
      feedHealthy: true, // Will be updated by health checks
      dataAgeMinutes: null,
      flashCount: 0,
      locationCount: 0,
      lastIngestion: null,
    });

    // Handle location subscriptions
    socket.on('join-location', (locationId: string) => {
      this.handleLocationSubscription(socket, locationId, 'join');
    });

    socket.on('leave-location', (locationId: string) => {
      this.handleLocationSubscription(socket, locationId, 'leave');
    });

    // Handle disconnection
    socket.on('disconnect', (reason: string) => {
      this.handleDisconnection(socket, reason);
    });

    // Handle errors
    socket.on('error', (error: Error) => {
      logger.error('WebSocket error', {
        socketId: socket.id,
        userId: socket.data.userId,
        error: error.message,
      });
    });
  }

  private handleLocationSubscription(socket: Socket, locationId: string, action: 'join' | 'leave'): void {
    if (action === 'join') {
      if (!this.locationSubscriptions.has(locationId)) {
        this.locationSubscriptions.set(locationId, new Set());
      }
      this.locationSubscriptions.get(locationId)!.add(socket.id);
      
      logger.debug('Client subscribed to location', {
        socketId: socket.id,
        userId: socket.data.userId,
        locationId,
        subscriberCount: this.locationSubscriptions.get(locationId)!.size,
      });
    } else {
      const subscribers = this.locationSubscriptions.get(locationId);
      if (subscribers) {
        subscribers.delete(socket.id);
        if (subscribers.size === 0) {
          this.locationSubscriptions.delete(locationId);
        }
      }
      
      logger.debug('Client unsubscribed from location', {
        socketId: socket.id,
        userId: socket.data.userId,
        locationId,
        remainingSubscribers: this.locationSubscriptions.get(locationId)?.size || 0,
      });
    }
  }

  private handleDisconnection(socket: Socket, reason: string): void {
    // Clean up subscriptions
    for (const [locationId, subscribers] of this.locationSubscriptions.entries()) {
      subscribers.delete(socket.id);
      if (subscribers.size === 0) {
        this.locationSubscriptions.delete(locationId);
      }
    }

    this.connectedClients.delete(socket.id);

    logger.info('Client disconnected', {
      socketId: socket.id,
      userId: socket.data.userId,
      userEmail: socket.data.userEmail,
      reason,
      remainingClients: this.connectedClients.size,
    });
  }

  // Public methods for broadcasting events
  broadcastRiskStateChange(data: Parameters<SocketEvents['risk-state-change']>[0]): void {
    if (!this.io) return;

    const subscribers = this.locationSubscriptions.get(data.locationId);
    const targetSockets = subscribers ? Array.from(subscribers) : Array.from(this.connectedClients.keys());

    targetSockets.forEach(socketId => {
      const socket = this.connectedClients.get(socketId);
      if (socket) {
        socket.emit('risk-state-change', data);
      }
    });

    logger.info('Risk state change broadcasted', {
      locationId: data.locationId,
      locationName: data.locationName,
      newState: data.newState,
      previousState: data.previousState,
      recipients: targetSockets.length,
    });
  }

  broadcastAlertTriggered(payload: WsAlertPayload): void {
    if (!this.io) return;

    // Send to all connected clients (alerts are important).
    // Emit under both event names — `alert-triggered` is the historical name
    // used by SocketEvents, and `alert.triggered` is the new dot-namespaced
    // name the client hook listens on. Keep both until all consumers migrate.
    this.io.emit('alert-triggered', payload);
    this.io.emit('alert.triggered' as any, payload);

    logger.info('Alert broadcasted', {
      locationId: payload.locationId,
      locationName: payload.locationName,
      alertType: payload.alertType,
      state: payload.state,
      recipients: this.connectedClients.size,
    });
  }

  broadcastSystemHealth(data: Parameters<SocketEvents['system-health']>[0]): void {
    if (!this.io) return;

    this.io.emit('system-health', data);

    logger.debug('System health broadcasted', {
      feedHealthy: data.feedHealthy,
      dataAgeMinutes: data.dataAgeMinutes,
      flashCount: data.flashCount,
      locationCount: data.locationCount,
      recipients: this.connectedClients.size,
    });
  }

  broadcastError(error: Parameters<SocketEvents['error']>[0]): void {
    if (!this.io) return;

    this.io.emit('error', error);

    logger.warn('Error broadcasted to clients', {
      errorMessage: error.message,
      errorCode: error.code,
      recipients: this.connectedClients.size,
    });
  }

  // Get connection statistics
  getStats(): {
    connectedClients: number;
    locationSubscriptions: Record<string, number>;
  } {
    const locationSubscriptions: Record<string, number> = {};
    for (const [locationId, subscribers] of this.locationSubscriptions.entries()) {
      locationSubscriptions[locationId] = subscribers.size;
    }

    return {
      connectedClients: this.connectedClients.size,
      locationSubscriptions,
    };
  }

  // Graceful shutdown
  shutdown(): void {
    if (this.io) {
      this.io.close(() => {
        logger.info('WebSocket server closed');
      });
    }
  }
}

export const wsManager = new WebSocketManager();
export default wsManager;

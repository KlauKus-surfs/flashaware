import { Server as HTTPServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { logger } from './logger';

// Extend Socket's data property to carry auth info
interface SocketData {
  userId: string;
  userEmail: string;
  userRole: string;
  userOrgId: string;
}

type AuthenticatedSocket = Socket & { data: SocketData };

// Payload broadcast to clients when an alert is triggered.
// Mirrored client-side in `client/src/useRealtimeAlerts.ts` (RealtimeAlert).
export interface WsAlertPayload {
  locationId: string;
  locationName: string;
  alertType: string; // 'system' | 'email' | 'sms' | 'whatsapp'
  state: string; // 'STOP' | 'PREPARE' | 'HOLD' | 'ALL_CLEAR' | 'DEGRADED'
  reason: string;
  timestamp: string; // ISO
  org_id: string; // tenant the alert belongs to (used for room-scoped broadcast)
}

// Socket event types
export interface SocketEvents {
  // Client -> Server
  'join-location': (locationId: string) => void;
  'leave-location': (locationId: string) => void;

  // Server -> Client
  'risk-state-change': (data: {
    locationId: string;
    // Tenant the location belongs to. Used to scope the room-based broadcast
    // so org A never sees org B's risk transitions in real time.
    org_id: string;
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

  error: (error: { message: string; code?: string }) => void;
}

class WebSocketManager {
  private io: SocketIOServer<SocketEvents, SocketEvents> | null = null;
  private connectedClients = new Map<string, AuthenticatedSocket>();

  async initialize(server: HTTPServer): Promise<void> {
    // Mirror the HTTP CORS posture: fail-closed in production, permissive
    // in dev. The HTTP server (index.ts) already throws at boot if
    // CORS_ORIGIN is unset in production, but websocket.ts could be
    // initialized in a separate process some day, so re-check here.
    const corsOriginRaw = process.env.CORS_ORIGIN?.trim();
    const wsAllowedOrigin = corsOriginRaw
      ? corsOriginRaw
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean)
      : process.env.NODE_ENV === 'production'
        ? false // unreachable: HTTP boot already threw, but belt-and-braces
        : true;
    this.io = new SocketIOServer(server, {
      cors: {
        origin: wsAllowedOrigin,
        credentials: true,
      },
      transports: ['websocket', 'polling'],
      // Aggressive ping so dead/stalled clients are evicted (and removed from
      // connectedClients via 'disconnect') within ~30s rather than hanging on
      // for the engine.io default of 5min. This is the main backpressure knob
      // for slow-network clients.
      pingTimeout: 20_000,
      pingInterval: 10_000,
    });

    // Multi-machine fan-out via Redis. Without this adapter, broadcasts only
    // reach clients connected to the emitting machine — fine today (single
    // Fly machine, leader is the only emitter via the advisory-lock gate),
    // but the moment min_machines_running > 1 is set, clients connected to a
    // follower silently miss every risk-state-change. Activated by setting
    // REDIS_URL; if unset, the default in-memory adapter stays in place.
    if (process.env.REDIS_URL) {
      await this.attachRedisAdapter(process.env.REDIS_URL);
    }

    // Authentication middleware
    this.io.use(async (socket: any, next: (err?: Error) => void) => {
      try {
        const token =
          (socket as any).handshake.auth.token ||
          (socket as any).handshake.headers.authorization?.replace('Bearer ', '');

        if (!token) {
          return next(new Error('Authentication required'));
        }

        const JWT_SECRET = process.env.JWT_SECRET;
        if (!JWT_SECRET || JWT_SECRET === 'change-me-to-a-random-secret-in-production') {
          logger.error('JWT_SECRET not configured properly');
          return next(new Error('Server configuration error'));
        }

        const decoded = jwt.verify(token, JWT_SECRET) as any;

        // JWTs live for ~8h. Without a DB recheck on connect, a deleted
        // user (or one whose org was soft-deleted) could still open a fresh
        // socket and continue receiving live risk-state-change broadcasts
        // for the rest of the token's lifetime. Mirror the HTTP
        // authenticate() recheck shape: confirm the user row still exists
        // AND its org isn't soft-deleted.
        try {
          const { getOne } = await import('./db');
          const row = await getOne<{ id: string }>(
            `SELECT u.id FROM users u
               INNER JOIN organisations o ON o.id = u.org_id AND o.deleted_at IS NULL
              WHERE u.id = $1`,
            [decoded.id],
          );
          if (!row) {
            logger.warn('WebSocket auth rejected — user revoked or org deleted', {
              userId: decoded.id,
              orgId: decoded.org_id,
            });
            return next(new Error('Account no longer active'));
          }
        } catch (dbErr) {
          // Don't fail open on DB hiccups: a JWT we can't recheck is treated
          // as untrusted. The client retries — same shape as HTTP's 500 on
          // recheck failure.
          logger.error('WebSocket auth recheck DB error', {
            error: (dbErr as Error).message,
          });
          return next(new Error('Authentication check failed'));
        }

        socket.data.userId = decoded.id;
        socket.data.userEmail = decoded.email;
        socket.data.userRole = decoded.role;
        socket.data.userOrgId = decoded.org_id;

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

  // Attach the socket.io Redis adapter so emit/join/leave fan out across
  // every machine connected to the same Redis. Failures are logged but
  // non-fatal: the server keeps running with the default in-memory adapter,
  // which means broadcasts are local-only. That degrades multi-machine
  // setups but is correct for single-machine ones, so we don't crash boot
  // over a Redis hiccup.
  private async attachRedisAdapter(url: string): Promise<void> {
    try {
      const [{ createAdapter }, { createClient }] = await Promise.all([
        import('@socket.io/redis-adapter'),
        import('redis'),
      ]);
      const pubClient = createClient({ url });
      const subClient = pubClient.duplicate();
      pubClient.on('error', (err: Error) =>
        logger.error('Redis pub client error', { error: err.message }),
      );
      subClient.on('error', (err: Error) =>
        logger.error('Redis sub client error', { error: err.message }),
      );
      await Promise.all([pubClient.connect(), subClient.connect()]);
      this.io!.adapter(createAdapter(pubClient, subClient));
      // Don't log REDIS_URL — it usually contains the auth token. Just confirm
      // the adapter is live so an operator can verify by tailing logs.
      logger.info('socket.io Redis adapter attached (multi-machine fan-out enabled)');
    } catch (err) {
      logger.error(
        'Failed to attach Redis adapter — falling back to in-memory (broadcasts local only)',
        { error: (err as Error).message },
      );
    }
  }

  private handleConnection(socket: Socket): void {
    this.connectedClients.set(socket.id, socket);

    // Scope this socket to its org so alert broadcasts only reach the right tenant.
    // super_admin joins a wildcard room so they see every tenant's events.
    // socket.join() returns Promise<void> when running with an external adapter
    // (e.g., Redis); on the default in-memory adapter it resolves synchronously.
    // We don't await — joining is best-effort and emit() handles unjoined rooms.
    const orgRoom = `org:${socket.data.userOrgId}`;
    void socket.join(orgRoom);
    if (socket.data.userRole === 'super_admin') {
      void socket.join('org:__all__');
    }

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

    // Handle location subscriptions. We no longer keep an in-memory map of
    // locationId → sockets — risk-state-change is fanned out via the per-org
    // socket.io room instead (see broadcastRiskStateChange). These handlers
    // remain so existing/future clients can opt into a per-location room for
    // targeted updates, but they MUST validate the location belongs to the
    // caller's org first; otherwise a malicious client could join an
    // arbitrary location's room and snoop on another tenant.
    socket.on('join-location', (locationId: string) => {
      void this.handleLocationSubscription(socket as AuthenticatedSocket, locationId, 'join');
    });

    socket.on('leave-location', (locationId: string) => {
      void this.handleLocationSubscription(socket as AuthenticatedSocket, locationId, 'leave');
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

  private async handleLocationSubscription(
    socket: AuthenticatedSocket,
    locationId: string,
    action: 'join' | 'leave',
  ): Promise<void> {
    const room = `location:${locationId}`;

    if (action === 'leave') {
      void socket.leave(room);
      logger.debug('Client unsubscribed from location', {
        socketId: socket.id,
        userId: socket.data.userId,
        locationId,
      });
      return;
    }

    // Verify the location belongs to the caller's org before letting them join
    // its room. Without this gate any authenticated user could subscribe to
    // an arbitrary location id (e.g. one from another tenant) and receive
    // future risk transitions for that site.
    if (typeof locationId !== 'string' || locationId.length === 0) {
      logger.warn('join-location rejected — invalid locationId', {
        socketId: socket.id,
        userId: socket.data.userId,
        locationId,
      });
      return;
    }

    try {
      const { getLocationById } = await import('./queries');
      const loc = await getLocationById(locationId);
      const isSuperAdmin = socket.data.userRole === 'super_admin';
      if (!loc || (!isSuperAdmin && loc.org_id !== socket.data.userOrgId)) {
        logger.warn('join-location rejected — cross-org or unknown location', {
          socketId: socket.id,
          userId: socket.data.userId,
          userOrgId: socket.data.userOrgId,
          locationId,
        });
        return;
      }
      void socket.join(room);
      logger.debug('Client subscribed to location', {
        socketId: socket.id,
        userId: socket.data.userId,
        locationId,
      });
    } catch (err) {
      logger.error('join-location lookup failed', {
        socketId: socket.id,
        locationId,
        error: (err as Error).message,
      });
    }
  }

  private handleDisconnection(socket: Socket, reason: string): void {
    // socket.io leaves all joined rooms automatically on disconnect; nothing
    // else to clean up since we no longer keep an in-memory subscription map.
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

    // Scope the broadcast to the location's tenant + super_admin wildcard.
    // socket.io dedupes if a socket sits in multiple of the targeted rooms.
    // Without this scoping a state change for org A's site would reach every
    // connected client, including users authenticated to org B.
    const orgRoom = `org:${data.org_id}`;
    this.io.to([orgRoom, 'org:__all__']).emit('risk-state-change', data);

    logger.info('Risk state change broadcasted', {
      locationId: data.locationId,
      org_id: data.org_id,
      locationName: data.locationName,
      newState: data.newState,
      previousState: data.previousState,
    });
  }

  broadcastAlertTriggered(payload: WsAlertPayload): void {
    if (!this.io) return;

    const orgRoom = `org:${payload.org_id}`;
    // Send to that org's sockets PLUS super_admins (in the wildcard room).
    // socket.io's `to(...).emit` deduplicates if a socket is in both rooms.
    // Emit under both event names — `alert-triggered` is the historical name
    // used by SocketEvents, and `alert.triggered` is the new dot-namespaced
    // name the client hook listens on. Keep both until all consumers migrate.
    const target = this.io.to([orgRoom, 'org:__all__']);
    target.emit('alert-triggered', payload);
    target.emit('alert.triggered' as any, payload);

    logger.info('Alert broadcasted', {
      locationId: payload.locationId,
      locationName: payload.locationName,
      alertType: payload.alertType,
      state: payload.state,
      org_id: payload.org_id,
    });
  }

  broadcastSystemHealth(data: Parameters<SocketEvents['system-health']>[0]): void {
    if (!this.io) return;

    // Volatile: if a client is stalled and has buffered messages, drop this
    // health beat rather than queuing yet another one. The next beat will
    // carry equivalent info — losing a system-health frame is harmless,
    // unlike risk-state-change which must be reliable.
    this.io.volatile.emit('system-health', data);

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
  } {
    return {
      connectedClients: this.connectedClients.size,
    };
  }

  // Graceful shutdown
  shutdown(): void {
    if (this.io) {
      void this.io.close(() => {
        logger.info('WebSocket server closed');
      });
    }
  }
}

export const wsManager = new WebSocketManager();
export default wsManager;

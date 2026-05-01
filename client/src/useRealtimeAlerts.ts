// client/src/useRealtimeAlerts.ts
import { useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';

export interface RealtimeAlert {
  locationId: string;
  locationName: string;
  alertType: string;
  state: string;
  reason: string;
  timestamp: string;
}

// Risk-engine state transitions (no alert dispatched). The dashboard cares
// about these too — recovery transitions like STOP→ALL_CLEAR don't dispatch
// alerts (intentionally silent), so without subscribing here the operator
// would wait up to 30 s for the next poll to see the green light.
export interface RealtimeStateChange {
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
}

interface Handlers {
  onAlert?: (a: RealtimeAlert) => void;
  onStateChange?: (s: RealtimeStateChange) => void;
}

/**
 * Subscribes to server-pushed alert events and risk-state transitions.
 * Reconnects automatically with exponential backoff on transient drops;
 * permanent failures (e.g. invalid token) silently fall back — the 30 s
 * polling on Dashboard still keeps data fresh, just less reactively.
 *
 * Connection target:
 * - Dev:  same-origin (Vite dev proxy upgrades /socket.io for us).
 * - Prod: VITE_WS_URL env var (e.g. https://lightning-risk-api.fly.dev) when
 *   the SPA is served from a different origin (Cloudflare Pages) than the
 *   API. If unset, falls back to same-origin.
 *
 * Backwards-compatible: callers that pass a single function are still
 * subscribed to alerts only.
 */
export function useRealtimeAlerts(
  arg: ((a: RealtimeAlert) => void) | Handlers,
) {
  const socketRef = useRef<Socket | null>(null);
  const handlersRef = useRef<Handlers>({});
  handlersRef.current = typeof arg === 'function' ? { onAlert: arg } : arg;

  useEffect(() => {
    const token = localStorage.getItem('flashaware_token');
    if (!token) return;

    const wsUrl = (import.meta as any).env?.VITE_WS_URL as string | undefined;

    const socket = wsUrl
      ? io(wsUrl, {
          auth: { token },
          reconnection: true,
          reconnectionDelay: 2000,
          reconnectionDelayMax: 30_000,
          reconnectionAttempts: Infinity,
          transports: ['websocket', 'polling'],
        })
      : io({
          auth: { token },
          reconnection: true,
          reconnectionDelay: 2000,
          reconnectionDelayMax: 30_000,
          reconnectionAttempts: Infinity,
          transports: ['websocket', 'polling'],
        });

    socketRef.current = socket;

    socket.on('alert.triggered', (payload: RealtimeAlert) => {
      handlersRef.current.onAlert?.(payload);
    });

    socket.on('risk-state-change', (payload: RealtimeStateChange) => {
      handlersRef.current.onStateChange?.(payload);
    });

    socket.on('connect_error', (err) => {
      if (err.message !== 'jwt expired') console.warn('[ws] connect_error:', err.message);
    });

    return () => { socket.close(); socketRef.current = null; };
  }, []);
}

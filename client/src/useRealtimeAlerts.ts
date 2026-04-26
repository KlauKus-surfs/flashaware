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

/**
 * Subscribes to server-pushed alert events. Reconnects automatically with
 * exponential backoff on transient drops; permanent failures (e.g. invalid
 * token) silently fall back — the 15s polling on Dashboard still keeps data
 * fresh, just less reactively.
 */
export function useRealtimeAlerts(onAlert: (a: RealtimeAlert) => void) {
  const socketRef = useRef<Socket | null>(null);
  const cbRef = useRef(onAlert);
  cbRef.current = onAlert;

  useEffect(() => {
    const token = localStorage.getItem('flashaware_token');
    if (!token) return;

    const socket = io({
      auth: { token },
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 30_000,
      reconnectionAttempts: Infinity,
      transports: ['websocket', 'polling'],
    });

    socketRef.current = socket;

    socket.on('alert.triggered', (payload: RealtimeAlert) => {
      cbRef.current(payload);
    });

    socket.on('connect_error', (err) => {
      if (err.message !== 'jwt expired') console.warn('[ws] connect_error:', err.message);
    });

    return () => { socket.close(); socketRef.current = null; };
  }, []);
}

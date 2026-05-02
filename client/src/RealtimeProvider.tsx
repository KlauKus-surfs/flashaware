import React, { createContext, useContext, useEffect, useMemo, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { RealtimeAlert, RealtimeStateChange } from './useRealtimeAlerts';

// Single shared socket.io connection for the whole signed-in session.
// Multiple components can subscribe via useRealtimeEvent('alert.triggered',
// handler) without each one opening its own WebSocket. Drops to a passive
// no-op when there's no JWT (e.g. on /login).
//
// Why not lift useRealtimeAlerts directly: that hook's contract was "open a
// socket per call" and the Dashboard relies on that side effect. Breaking it
// without a plan would silently drop subscriptions in prod. The provider
// gives every screen a way in via useRealtimeEvent, and useRealtimeAlerts
// keeps working unchanged for the screen that already uses it.

type EventName = 'alert.triggered' | 'alert-triggered' | 'risk-state-change' | 'system-health';

type AnyHandler = (payload: any) => void;

interface RealtimeCtx {
  // subscribe returns an unsubscribe fn — same shape as socket.io's `off`.
  subscribe: <T = any>(event: EventName, handler: (payload: T) => void) => () => void;
  // connection status — can be wired into the AppBar later.
  connected: boolean;
}

const Ctx = createContext<RealtimeCtx | null>(null);

function makeSocket(token: string): Socket {
  const wsUrl = (import.meta as any).env?.VITE_WS_URL as string | undefined;
  const opts = {
    auth: { token },
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 30_000,
    reconnectionAttempts: Infinity,
    transports: ['websocket', 'polling'],
  };
  return wsUrl ? io(wsUrl, opts) : io(opts);
}

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  // Ref so subscribe() can register listeners on a socket that hasn't connected yet.
  const socketRef = useRef<Socket | null>(null);
  // Pending subscriptions registered before socket existed; replayed on connect.
  const pendingRef = useRef<Array<{ event: EventName; handler: AnyHandler }>>([]);
  const [connected, setConnected] = React.useState(false);

  useEffect(() => {
    const token = localStorage.getItem('flashaware_token');
    if (!token) return;
    const socket = makeSocket(token);
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', (err) => {
      if (err.message !== 'jwt expired') {
        // Surface only first occurrence per session — reconnection storms
        // would otherwise spam the console.
        console.warn('[ws] connect_error:', err.message);
      }
      setConnected(false);
    });

    // Replay listeners that subscribed before the socket existed.
    for (const { event, handler } of pendingRef.current) {
      socket.on(event, handler);
    }
    pendingRef.current = [];

    return () => {
      socket.close();
      socketRef.current = null;
      setConnected(false);
    };
  }, []);

  const subscribe = useCallback<RealtimeCtx['subscribe']>((event, handler) => {
    const wrapped: AnyHandler = (p) => handler(p);
    if (socketRef.current) {
      socketRef.current.on(event, wrapped);
    } else {
      pendingRef.current.push({ event, handler: wrapped });
    }
    return () => {
      socketRef.current?.off(event, wrapped);
      pendingRef.current = pendingRef.current.filter((p) => p.handler !== wrapped);
    };
  }, []);

  const value = useMemo(() => ({ subscribe, connected }), [subscribe, connected]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// useRealtimeEvent('alert.triggered', payload => { ... }) — register a
// listener for the lifetime of the calling component. Multiple screens can
// listen to the same event without opening separate sockets.
export function useRealtimeEvent<T = any>(event: EventName, handler: (payload: T) => void) {
  const ctx = useContext(Ctx);
  // Stash the latest handler in a ref so we don't re-subscribe on every
  // re-render (closures over fresh state still work).
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!ctx) return;
    const unsubscribe = ctx.subscribe<T>(event, (p) => handlerRef.current(p));
    return unsubscribe;
  }, [ctx, event]);
}

// Re-export the payload types for convenience.
export type { RealtimeAlert, RealtimeStateChange };

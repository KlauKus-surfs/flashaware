import React, { createContext, useContext, useEffect, useMemo, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { useOrgScope } from './OrgScope';
import { logger } from './utils/logger';

// Single shared socket.io connection for the whole signed-in session.
// Multiple components subscribe via useRealtimeEvent('alert.triggered',
// handler) without each one opening its own WebSocket. Drops to a passive
// no-op when there's no JWT (e.g. on /login).

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

type EventName = 'alert.triggered' | 'alert-triggered' | 'risk-state-change' | 'system-health';

type AnyHandler = (payload: any) => void;

interface RealtimeCtx {
  // subscribe returns an unsubscribe fn — same shape as socket.io's `off`.
  subscribe: <T = any>(event: EventName, handler: (payload: T) => void) => () => void;
  // connection status — wired into the data-freshness banner.
  connected: boolean;
}

const Ctx = createContext<RealtimeCtx | null>(null);

function makeSocket(token: string | null): Socket {
  const wsUrl = (import.meta as any).env?.VITE_WS_URL as string | undefined;
  const opts = {
    // Cookie path is the primary auth surface now; the fa_auth httpOnly
    // cookie rides on the websocket upgrade when withCredentials is set.
    // We still attach `auth.token` if a (legacy) JWT is present so existing
    // sessions don't have to re-login during the migration.
    ...(token ? { auth: { token } } : {}),
    withCredentials: true,
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
  const { scopedOrgId } = useOrgScope();
  // Stash the latest scope in a ref so the connect listener can read the
  // current value without re-creating the socket on every scope change.
  const scopeRef = useRef<string | null>(scopedOrgId);
  scopeRef.current = scopedOrgId;

  useEffect(() => {
    // Cookie path: the fa_auth httpOnly cookie rides on the websocket upgrade
    // (via withCredentials), so a fresh post-login session has no JS-visible
    // token but still authenticates server-side. Read the legacy localStorage
    // entry only as a fallback for browsers mid-migration.
    const legacyToken = localStorage.getItem('flashaware_token');
    // Confirm we have *some* session signal — either the persisted user
    // record (post-login) or a legacy token. Without this we'd spin up a
    // socket on the login page.
    const hasUser = !!localStorage.getItem('flashaware_user');
    if (!hasUser && !legacyToken) return;
    const socket = makeSocket(legacyToken);
    socketRef.current = socket;

    // socket.io fires `connect` on every successful (re)connect. The server
    // auto-joins the user's own org room from the JWT in the connection
    // handler, so non-super clients are correctly scoped without any client
    // emit. For super_admin, the server defaults to org:__all__; we narrow
    // it to the picked tenant by emitting subscribe-scope here. The same
    // emit runs on every reconnect, so a network blip can't silently leave
    // us subscribed to the wrong room after a scope change.
    socket.on('connect', () => {
      setConnected(true);
      socket.emit('subscribe-scope', { orgId: scopeRef.current ?? null });
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', (err) => {
      if (err.message !== 'jwt expired') {
        // Surface only first occurrence per session — reconnection storms
        // would otherwise spam the console.
        logger.warn('[ws] connect_error:', err.message);
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

  // When the super_admin changes scope, push the new scope to the live socket
  // without tearing down the connection. Skipped if not yet connected — the
  // connect handler reads scopeRef.current and will emit the right value.
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || !socket.connected) return;
    socket.emit('subscribe-scope', { orgId: scopedOrgId ?? null });
  }, [scopedOrgId]);

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

// useRealtimeConnection() — subscribe to the live socket-connected flag
// without registering an event handler. Used by the data-freshness banner.
// Returns false when the provider is mounted but unauthenticated (no JWT)
// — visually identical to "disconnected" from the operator's POV.
export function useRealtimeConnection(): boolean {
  const ctx = useContext(Ctx);
  return ctx?.connected ?? false;
}

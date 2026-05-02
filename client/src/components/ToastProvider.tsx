import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Snackbar, Alert, AlertColor, Button } from '@mui/material';

type Severity = AlertColor;

interface ToastAction {
  label: string;
  // Awaited so the toast can show a brief in-flight state and dismiss on
  // success. Throws are swallowed by the toast — callers should toast their
  // own follow-up error if needed.
  onClick: () => void | Promise<void>;
}

interface ToastOptions {
  action?: ToastAction;
  // When set, overrides the per-severity default. Set to null for sticky.
  durationMs?: number | null;
}

interface QueuedToast {
  id: number;
  message: string;
  severity: Severity;
  action?: ToastAction;
  durationMs?: number | null;
}

interface ToastApi {
  show: (message: string, severity?: Severity, opts?: ToastOptions) => void;
  success: (message: string, opts?: ToastOptions) => void;
  error: (message: string, opts?: ToastOptions) => void;
  info: (message: string, opts?: ToastOptions) => void;
  warning: (message: string, opts?: ToastOptions) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

// Per-severity duration: errors stay long enough to read before they auto-dismiss
// (a 4s flash on a stack trace is not enough). Successes can be brief — but
// when there's an action button we hold the toast longer so the operator
// actually has time to click "Undo".
const DURATION_MS: Record<Severity, number> = {
  success: 3500,
  info: 4000,
  warning: 6000,
  error: 8000,
};
const ACTION_HOLD_MS = 7000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [queue, setQueue] = useState<QueuedToast[]>([]);
  const [open, setOpen] = useState(false);
  const idRef = useRef(0);

  const current = queue[0];

  // Open the snackbar exactly once per queued toast — keyed on `current?.id`
  // rather than `open`. Previously this effect listed `open` in its deps, so
  // every dismissal (close button, auto-hide timer) flipped open=false, fired
  // the effect again, and re-opened the same toast. The exit transition got
  // interrupted before MUI's `onExited` could splice the queue, leaving the
  // toast stuck in a re-open loop. The phone-verified success was the
  // canonical reproduction: user reads it, taps X, watches it bounce back.
  useEffect(() => {
    if (current) setOpen(true);
  }, [current?.id]);

  const show = useCallback(
    (message: string, severity: Severity = 'success', opts?: ToastOptions) => {
      setQueue((q) => [
        ...q,
        {
          id: ++idRef.current,
          message,
          severity,
          action: opts?.action,
          durationMs: opts?.durationMs,
        },
      ]);
    },
    [],
  );

  const handleClose = (_event?: React.SyntheticEvent | Event, reason?: string) => {
    if (reason === 'clickaway') return;
    setOpen(false);
  };

  const handleExited = () => {
    setQueue((q) => q.slice(1));
  };

  const api: ToastApi = {
    show,
    success: (m, opts) => show(m, 'success', opts),
    error: (m, opts) => show(m, 'error', opts),
    info: (m, opts) => show(m, 'info', opts),
    warning: (m, opts) => show(m, 'warning', opts),
  };

  // If the caller supplied an action (e.g. "Undo"), hold the toast for at
  // least ACTION_HOLD_MS so they have time to click. `durationMs: null` on
  // the toast options keeps it sticky until dismissed.
  const autoHide =
    current?.durationMs === null
      ? null
      : (current?.durationMs ??
        (current?.action ? ACTION_HOLD_MS : current ? DURATION_MS[current.severity] : null));

  const handleActionClick = async () => {
    if (!current?.action) return;
    try {
      await current.action.onClick();
    } catch {
      // Caller is responsible for surfacing follow-up errors.
    } finally {
      setOpen(false);
    }
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <Snackbar
        key={current?.id ?? 'idle'}
        open={open}
        autoHideDuration={autoHide ?? undefined}
        onClose={handleClose}
        TransitionProps={{ onExited: handleExited }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity={current?.severity ?? 'success'}
          variant="filled"
          onClose={handleClose}
          action={
            current?.action ? (
              <Button
                color="inherit"
                size="small"
                onClick={handleActionClick}
                sx={{ fontWeight: 700 }}
              >
                {current.action.label}
              </Button>
            ) : undefined
          }
        >
          {current?.message ?? ''}
        </Alert>
      </Snackbar>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

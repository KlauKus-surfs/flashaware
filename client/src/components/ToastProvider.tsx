import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Snackbar, Alert, AlertColor } from '@mui/material';

type Severity = AlertColor;

interface QueuedToast {
  id: number;
  message: string;
  severity: Severity;
}

interface ToastApi {
  show: (message: string, severity?: Severity) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
  warning: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

// Per-severity duration: errors stay long enough to read before they auto-dismiss
// (a 4s flash on a stack trace is not enough). Successes can be brief.
const DURATION_MS: Record<Severity, number> = {
  success: 3500,
  info:    4000,
  warning: 6000,
  error:   8000,
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  // Queue rather than a single slot so rapid-fire toasts (bulk operations) all
  // get shown — previously the second of two errors fired in the same tick
  // would clobber the first before the user could read it.
  const [queue, setQueue] = useState<QueuedToast[]>([]);
  const [open, setOpen] = useState(false);
  const idRef = useRef(0);

  const current = queue[0];

  // Open the snackbar whenever a fresh toast reaches the head of the queue.
  useEffect(() => {
    if (current && !open) setOpen(true);
  }, [current, open]);

  const show = useCallback((message: string, severity: Severity = 'success') => {
    setQueue(q => [...q, { id: ++idRef.current, message, severity }]);
  }, []);

  const handleClose = (_event?: React.SyntheticEvent | Event, reason?: string) => {
    // Clicks elsewhere on the page shouldn't dismiss errors — only an explicit
    // close (X button) or the timeout. Same default MUI uses for clickaway.
    if (reason === 'clickaway') return;
    setOpen(false);
  };

  // After the exit transition, drop the head of the queue so the next one can
  // animate in. Prevents the next toast from inheriting the previous severity
  // colour mid-transition.
  const handleExited = () => {
    setQueue(q => q.slice(1));
  };

  const api: ToastApi = {
    show,
    success: (m) => show(m, 'success'),
    error:   (m) => show(m, 'error'),
    info:    (m) => show(m, 'info'),
    warning: (m) => show(m, 'warning'),
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <Snackbar
        key={current?.id ?? 'idle'}
        open={open}
        autoHideDuration={current ? DURATION_MS[current.severity] : null}
        onClose={handleClose}
        TransitionProps={{ onExited: handleExited }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity={current?.severity ?? 'success'} variant="filled" onClose={handleClose}>
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

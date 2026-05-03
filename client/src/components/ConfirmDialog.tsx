import React, { createContext, useCallback, useContext, useState } from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle } from '@mui/material';

// Promise-based confirm dialog. Replaces window.confirm() for safety-critical
// guards: native confirm is dismissable by hitting Enter without reading,
// renders outside the app's typography, and on some Chromium variants is
// suppressed entirely after a few uses on the same origin.
//
// Usage:
//   const confirm = useConfirm();
//   if (!(await confirm({ title: '...', message: '...', confirmLabel: 'Save anyway' }))) return;

export type ConfirmTone = 'default' | 'warning' | 'danger';

export interface ConfirmOptions {
  title: string;
  message: string | React.ReactNode;
  /** Defaults to "Confirm". Set to something verb-y like "Save anyway" so
   *  the operator commits to the action rather than reflex-clicking OK. */
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
}

type Resolver = (value: boolean) => void;

interface InternalState extends ConfirmOptions {
  open: boolean;
  resolve: Resolver | null;
}

const ConfirmContext = createContext<((opts: ConfirmOptions) => Promise<boolean>) | null>(null);

const TONE_TO_COLOR: Record<ConfirmTone, 'primary' | 'warning' | 'error'> = {
  default: 'primary',
  warning: 'warning',
  danger: 'error',
};

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<InternalState>({
    open: false,
    title: '',
    message: '',
    resolve: null,
  });

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setState({
        open: true,
        title: opts.title,
        message: opts.message,
        confirmLabel: opts.confirmLabel,
        cancelLabel: opts.cancelLabel,
        tone: opts.tone,
        resolve,
      });
    });
  }, []);

  const handleClose = (value: boolean) => {
    // Resolve before closing so the awaiter can re-render synchronously
    // without racing the dialog's exit transition.
    state.resolve?.(value);
    setState((s) => ({ ...s, open: false, resolve: null }));
  };

  const tone = state.tone ?? 'warning';

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={state.open}
        onClose={() => handleClose(false)}
        // Disable backdrop dismissal for danger-tone confirms — power users
        // sometimes click outside reflexively. Cancel via the explicit button.
        disableEscapeKeyDown={tone === 'danger'}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>{state.title}</DialogTitle>
        <DialogContent>
          {typeof state.message === 'string' ? (
            <DialogContentText>{state.message}</DialogContentText>
          ) : (
            state.message
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => handleClose(false)} color="inherit">
            {state.cancelLabel ?? 'Cancel'}
          </Button>
          <Button
            onClick={() => handleClose(true)}
            color={TONE_TO_COLOR[tone]}
            variant="contained"
            autoFocus={tone !== 'danger'}
          >
            {state.confirmLabel ?? 'Confirm'}
          </Button>
        </DialogActions>
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): (opts: ConfirmOptions) => Promise<boolean> {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used inside <ConfirmProvider>');
  return ctx;
}

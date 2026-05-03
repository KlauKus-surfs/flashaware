// Dev-only console wrappers. In production these no-op so the user's devtools
// console isn't cluttered with caught fetch errors and reconnect-storm
// warnings — operators reporting bugs will still see real uncaught errors
// (those go through the React ErrorBoundary, which logs unconditionally).
//
// If/when the server grows an error-collection endpoint, swap the no-op
// branch here for a fetch() POST. Centralising the call site means we don't
// have to chase 14 console.warn / console.error scattered across the SPA.
//
// Intentionally NOT wired into the React ErrorBoundary's componentDidCatch —
// that one logs to console deliberately so a user who already hit "FlashAware
// crashed" can paste the stack trace into a bug report.

const isDev =
  typeof import.meta !== 'undefined' &&
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (import.meta as any).env?.DEV === true;

export const logger = {
  warn(...args: unknown[]): void {
    if (isDev) console.warn(...args);
  },
  error(...args: unknown[]): void {
    if (isDev) console.error(...args);
  },
};

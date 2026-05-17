import React, { useEffect, useState } from 'react';
import { Alert, Snackbar, Button } from '@mui/material';
// `virtual:pwa-register/react` is a virtual module emitted by vite-plugin-pwa
// at build time. Module typings come from the triple-slash ref in
// client/src/global.d.ts (must be in a .d.ts to apply project-wide).
import { useRegisterSW } from 'virtual:pwa-register/react';

/**
 * Two related pieces of operator-visible UX that exist because this is a
 * safety-of-life tool and a stale cached shell would be dangerous:
 *
 * 1. **Update banner** — when a new service-worker bundle installs, prompt
 *    the operator to reload. We don't `skipWaiting()` silently because a
 *    live STOP state should never disappear under their feet mid-incident.
 * 2. **Offline banner** — surfaces `navigator.onLine === false` because the
 *    SW is configured `NetworkOnly` for /api and /socket.io. The dashboard
 *    will stop updating with no obvious cause otherwise; this gives the
 *    operator something concrete to act on.
 */
export default function PWAStatus() {
  const [offline, setOffline] = useState(
    typeof navigator !== 'undefined' && !navigator.onLine,
  );

  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError(err: unknown) {
      // The SW is a progressive enhancement — registration failure should
      // never break the app. Log and move on.
      // eslint-disable-next-line no-console
      console.warn('[pwa] SW registration failed', err);
    },
  });

  return (
    <>
      {/* Offline banner — persistent until the connection returns. */}
      <Snackbar
        open={offline}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
        sx={{ mt: 1 }}
      >
        <Alert severity="warning" variant="filled" sx={{ width: '100%' }}>
          You're offline. Risk evaluation cannot update — treat any displayed state as stale.
        </Alert>
      </Snackbar>

      {/* Update-available prompt — only shown when a new SW is waiting. */}
      <Snackbar
        open={needRefresh}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        <Alert
          severity="info"
          variant="filled"
          action={
            <>
              <Button
                color="inherit"
                size="small"
                onClick={() => updateServiceWorker(true)}
                sx={{ fontWeight: 600 }}
              >
                Reload
              </Button>
              <Button color="inherit" size="small" onClick={() => setNeedRefresh(false)}>
                Later
              </Button>
            </>
          }
        >
          A new version of FlashAware is ready.
        </Alert>
      </Snackbar>
    </>
  );
}

import React from 'react';
import { Box, Typography } from '@mui/material';

// `__APP_VERSION__` / `__APP_BUILD__` are bundle-time string literals
// injected via Vite's `define` (see vite.config.ts). Ambient declarations
// live in client/src/global.d.ts so other files can use them too.

/**
 * Small "v1.0.0 · 1a2b3c4" pill anchored to the bottom-left of the unauth
 * shells. Operators reporting bugs paste this verbatim, so it has to render
 * even on a brand-new install before any API call succeeds — hence the
 * bundle-time string injection (no env fetch).
 */
export default function AppVersionChip() {
  return (
    <Box
      sx={{
        position: 'fixed',
        bottom: 12,
        left: 12,
        zIndex: 2,
        px: 1.25,
        py: 0.5,
        borderRadius: 999,
        bgcolor: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
        color: 'text.secondary',
        pointerEvents: 'none',
        userSelect: 'all',
      }}
    >
      <Typography variant="caption" sx={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: 10 }}>
        v{__APP_VERSION__} · {__APP_BUILD__}
      </Typography>
    </Box>
  );
}

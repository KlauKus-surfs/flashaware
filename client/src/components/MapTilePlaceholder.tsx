import React from 'react';
import { Box, CircularProgress, Typography } from '@mui/material';

// Sits on top of a Leaflet MapContainer until its TileLayer fires `load`.
// Without this the basemap can take a beat to render on first paint and the
// visible state — radius rings + the green centroid dot suspended over an
// empty grey rectangle — looks indistinguishable from a broken map. Pair this
// with `eventHandlers={{ load: () => setTilesLoaded(true) }}` on the
// TileLayer and `position: relative` on the MapContainer's wrapper.
export default function MapTilePlaceholder({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <Box
      role="status"
      aria-live="polite"
      sx={{
        position: 'absolute',
        inset: 0,
        zIndex: 500,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1.25,
        // The map's own background is a near-black grey in dark mode and a
        // light grey in light mode; we want the placeholder to fade against
        // both without re-introducing a hard-coded backdrop, so use a
        // semi-transparent paper-on-paper effect instead.
        bgcolor: 'background.default',
        opacity: 0.7,
        // Don't swallow map clicks once the overlay starts to fade — the
        // placeholder is informational only.
        pointerEvents: 'none',
      }}
    >
      <CircularProgress size={20} thickness={5} />
      <Typography variant="caption" sx={{ fontWeight: 500 }}>
        Loading map…
      </Typography>
    </Box>
  );
}

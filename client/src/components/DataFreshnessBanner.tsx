import { Alert, AlertTitle, Box } from '@mui/material';
import WifiOffIcon from '@mui/icons-material/WifiOff';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';

// Sticky, full-width "trust the screen?" banner for operators making
// time-pressured decisions. Two failure modes are surfaced explicitly:
//
//  • WebSocket disconnected — live updates are paused, the dashboard
//    is showing whatever the last poll saw. The 30s poll usually papers
//    over this within seconds, but the small chip at the top of the
//    AppBar isn't a strong-enough signal during a live storm.
//
//  • Feed lag (dataAgeMinutes > threshold) — EUMETSAT product is
//    behind schedule. The risk engine hasn't flipped DEGRADED yet
//    (that happens at 25 min) but operators should be wary at 10+ min.
//
// Returns null when everything is healthy so it disappears entirely
// from the layout, leaving no empty space.
export interface DataFreshnessBannerProps {
  connected: boolean;
  dataAgeMinutes: number | null | undefined;
  // Threshold at which to call the feed "lagging". Default matches the
  // health endpoint's `feedTier === 'lagging'` band (>12 min).
  staleMinutes?: number;
  // When the data age is unknown (e.g. health endpoint hasn't loaded
  // yet), suppress the lag warning to avoid flapping during initial load.
  suppressOnUnknown?: boolean;
}

export function DataFreshnessBanner({
  connected,
  dataAgeMinutes,
  staleMinutes = 12,
  suppressOnUnknown = true,
}: DataFreshnessBannerProps) {
  const ageKnown = dataAgeMinutes !== null && dataAgeMinutes !== undefined;
  const isLagging = ageKnown && (dataAgeMinutes as number) > staleMinutes;
  const isStale = ageKnown && (dataAgeMinutes as number) > 20;
  const ageUnknown = !ageKnown && !suppressOnUnknown;

  if (connected && !isLagging && !isStale && !ageUnknown) return null;

  // Severity escalates: disconnected OR truly stale → error; lagging → warning.
  const severity: 'error' | 'warning' = !connected || isStale ? 'error' : 'warning';
  const Icon = !connected ? WifiOffIcon : HourglassEmptyIcon;

  let title = 'Live data paused';
  let body = '';
  if (!connected && isStale) {
    title = 'Live data paused — feed is also stale';
    body = `Last EUMETSAT product was ${dataAgeMinutes} min ago. Treat the screen as out-of-date and verify before standing operations down.`;
  } else if (!connected) {
    title = 'Live data paused';
    body =
      'WebSocket disconnected — the dashboard is no longer receiving real-time updates. Showing the last polled snapshot. Reconnecting…';
  } else if (isStale) {
    title = 'Lightning feed is stale';
    body = `Last EUMETSAT product was ${dataAgeMinutes} min ago (engine flips DEGRADED at 25 min). Risk evaluations may be based on out-of-date data.`;
  } else if (isLagging) {
    title = 'Lightning feed is lagging';
    body = `Last EUMETSAT product was ${dataAgeMinutes} min ago. Updates usually arrive every ~10 min — flag to ops if this persists.`;
  } else {
    title = 'Data freshness unknown';
    body = 'Waiting on the first health probe — the dashboard will update once status loads.';
  }

  return (
    <Box
      role="status"
      aria-live="polite"
      sx={{
        position: 'sticky',
        top: 0,
        zIndex: (t) => t.zIndex.appBar + 1,
        mb: 1,
      }}
    >
      <Alert
        severity={severity}
        icon={<Icon fontSize="inherit" />}
        sx={{ borderRadius: 0, alignItems: 'center' }}
      >
        <AlertTitle sx={{ mb: 0.25 }}>{title}</AlertTitle>
        {body}
      </Alert>
    </Box>
  );
}

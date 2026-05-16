import { useState, useEffect, useCallback } from 'react';
import {
  Box,
  Chip,
  Skeleton,
  Tooltip,
  IconButton,
  LinearProgress,
  Alert,
  Button,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import FlashOnIcon from '@mui/icons-material/FlashOn';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import RadarIcon from '@mui/icons-material/Radar';
import LocationOnIcon from '@mui/icons-material/LocationOn';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import SignalCellularAltIcon from '@mui/icons-material/SignalCellularAlt';
import { useTheme, useMediaQuery } from '@mui/material';
import { nowSAST, displayZoneLabel } from './utils/format';
import { getStatus, getFlashes, getHealth, getOnboardingState, getLocations } from './api';
import { useOrgScope } from './OrgScope';
import { STATE_RANK } from './states';
import {
  useRealtimeConnection,
  useRealtimeEvent,
  type RealtimeAlert,
  type RealtimeStateChange,
} from './RealtimeProvider';
import { DataFreshnessBanner } from './components/DataFreshnessBanner';
import SetupChecklist from './components/SetupChecklist';
import EmptyState from './components/EmptyState';
import StateGlossaryButton from './components/StateGlossary';
import { useNavigate } from 'react-router-dom';
import { playAlertBeep } from './dashboard/playAlertBeep';
import { FeedTierLabel } from './dashboard/FeedTierLabel';
import { StatCard } from './dashboard/StatCard';
import { StatusCard } from './dashboard/StatusCard';
import { DashboardMap } from './dashboard/DashboardMap';
import type { Flash, LocationStatus } from './dashboard/types';
import { useAfaPixels } from './MapLayers';
import { logger } from './utils/logger';

export default function Dashboard() {
  const { scopedOrgId } = useOrgScope();
  const navigate = useNavigate();
  const [locations, setLocations] = useState<LocationStatus[]>([]);
  const [flashes, setFlashes] = useState<Flash[]>([]);
  const [health, setHealth] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pulseId, setPulseId] = useState<string | null>(null);
  // Screen-reader announcement for the latest risk-state change. Mounted in
  // a visually-hidden aria-live region near the top of the dashboard so
  // assistive tech catches every transition without the operator having to
  // hunt for changed cards. Polite (not assertive) so STOP-after-STOP
  // transitions don't interrupt the user mid-sentence.
  const [announcement, setAnnouncement] = useState<string>('');
  const [showNotifBanner, setShowNotifBanner] = useState(false);
  const [onboarding, setOnboarding] = useState<{
    hasLocation: boolean;
    hasRecipient: boolean;
    hasVerifiedPhone: boolean;
  } | null>(null);
  const [fitVersion, setFitVersion] = useState(0);
  // /api/status only returns enabled locations (correct for the live grid),
  // so we fetch /api/locations separately to surface "X disabled" — operators
  // need to know they have a site that isn't being evaluated even though it
  // doesn't appear above.
  const [disabledCount, setDisabledCount] = useState(0);
  // Demo data is hidden by default — production operators don't want test
  // sites mixed in with real customer locations. Persisted so the toggle
  // sticks across reloads for whoever is poking at fixtures.
  const [showDemo, setShowDemo] = useState<boolean>(
    () => localStorage.getItem('flashaware_show_demo') === '1',
  );

  // AFA pixel count — used to adapt the flash-counter label after cutover.
  // The hook manages its own polling + WS subscription; two callers (here and
  // DashboardMap) are safe because each hook instance is independent.
  const afaPixels = useAfaPixels();

  useEffect(() => {
    getOnboardingState(scopedOrgId ?? undefined)
      .then((r) => setOnboarding(r.data))
      .catch((err) => {
        logger.warn('Failed to load onboarding state', err);
        setOnboarding(null);
      });
  }, [scopedOrgId]);

  useEffect(() => {
    // Ask once. Browser remembers the answer; if denied, we silently skip.
    // We also persist a "dismissed" flag so closing the banner doesn't bring
    // it back on every reload. Permission still 'default' AND user hasn't
    // explicitly dismissed = show.
    const dismissed = localStorage.getItem('flashaware_notif_dismissed') === '1';
    if ('Notification' in window && Notification.permission === 'default' && !dismissed) {
      setShowNotifBanner(true);
    }
  }, []);

  const handleNotifBannerClose = () => {
    setShowNotifBanner(false);
    localStorage.setItem('flashaware_notif_dismissed', '1');
  };

  // Real-time alert subscription. We optimistically merge the new state into
  // local `locations` so the operator sees the change BEFORE the next 30s
  // poll, then trigger a 4s pulse. Audio fires only on worsening (lower
  // STATE_RANK) — improvements are silent so we don't desensitise operators.
  // We listen on TWO channels through the shared RealtimeProvider socket:
  //   • alert.triggered  — alert dispatched (STOP/HOLD/PREPARE/DEGRADED).
  //   • risk-state-change — every transition, including silent recoveries
  //     to ALL_CLEAR. Without this, "the storm passed" lags the dashboard
  //     by up to a poll interval.
  // Uses useRealtimeEvent (not a per-hook io() call) so the whole signed-in
  // session has exactly one WebSocket — previously Dashboard opened a second
  // socket alongside RealtimeProvider, doubling fanout cost and double-firing
  // every alert into the optimistic-merge handler.
  useRealtimeEvent<RealtimeAlert>('alert.triggered', (alert) => {
    const prev = locations.find((l) => l.id === alert.locationId);
    // Two paths:
    //   1. Known location → compare ranks, optimistically merge into state.
    //   2. Unknown location (created in another tab, or appeared after
    //      a super_admin scope flip without a /api/status poll yet).
    //      Earlier this branch was a silent return — which meant a real
    //      STOP could fire while the dashboard's audio alarm stayed quiet.
    //      Now: assume worsening (we have no prior to compare), still
    //      beep + notify + announce, and trigger a fetch so the card
    //      appears on the next render.
    if (!prev) {
      playAlertBeep();
      if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
        new Notification('FlashAware: ' + alert.state, {
          body: `${alert.locationName}: ${alert.reason}`,
          tag: alert.locationId,
          requireInteraction: alert.state === 'STOP',
        });
      }
      setAnnouncement(`${alert.locationName} is now ${alert.state}: ${alert.reason}`);
      // Pull the new location into local state on the next tick. The
      // .catch swallows because the regular 30s poll will catch up if
      // this fails — we don't want to surface a transient fetch error
      // mid-storm.
      void fetchData().catch(() => {});
      return;
    }
    const prevRank = STATE_RANK[(prev.state ?? 'ALL_CLEAR') as keyof typeof STATE_RANK] ?? 5;
    const newRank = STATE_RANK[alert.state as keyof typeof STATE_RANK] ?? 5;
    const worsened = newRank < prevRank;

    if (worsened) {
      playAlertBeep();
      if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
        new Notification('FlashAware: ' + alert.state, {
          body: `${alert.locationName}: ${alert.reason}`,
          tag: alert.locationId,
          requireInteraction: alert.state === 'STOP',
        });
      }
    }

    setLocations((cur) =>
      cur.map((l) => (l.id === alert.locationId ? { ...l, state: alert.state } : l)),
    );
    setPulseId(alert.locationId);
    setTimeout(() => setPulseId((curr) => (curr === alert.locationId ? null : curr)), 4000);
    setAnnouncement(`${alert.locationName} is now ${alert.state}: ${alert.reason}`);
  });

  // State-only updates (no alert dispatched). The big case is recovery to
  // ALL_CLEAR — operators want to see green as soon as the engine clears.
  // We don't beep or pulse here; recovery is intentionally quiet.
  useRealtimeEvent<RealtimeStateChange>('risk-state-change', (change) => {
    setLocations((cur) => {
      const matched = cur.find((l) => l.id === change.locationId);
      if (matched && matched.state !== change.newState) {
        // Announce silent transitions (e.g. ALL_CLEAR recovery) to screen
        // readers — the audio beep is suppressed for non-worsening changes
        // but blind operators still need to hear it.
        setAnnouncement(`${matched.name} cleared to ${change.newState}`);
      }
      return cur.map((l) =>
        l.id === change.locationId
          ? {
              ...l,
              state: change.newState,
              evaluated_at: change.evaluatedAt,
              flashes_in_stop_radius: change.flashesInStopRadius,
              flashes_in_prepare_radius: change.flashesInPrepareRadius,
              nearest_flash_km: change.nearestFlashKm,
              is_degraded: change.isDegraded,
            }
          : l,
      );
    });
  });

  const fetchData = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const [statusRes, flashRes, healthRes, locsRes] = await Promise.all([
          getStatus(scopedOrgId ?? undefined, { signal }),
          getFlashes({ minutes: 30 }, { signal }),
          getHealth({ signal }),
          // All locations (including disabled) — used solely for the
          // "X disabled" hint in the header. Cheap query (small org-scoped
          // result set), so we don't bother caching it.
          getLocations(scopedOrgId ?? undefined, { signal }),
        ]);
        if (signal?.aborted) return;
        setLocations(statusRes.data);
        setFlashes(flashRes.data);
        setHealth(healthRes.data);
        setDisabledCount(
          Array.isArray(locsRes.data)
            ? locsRes.data.filter((l: any) => l && l.enabled === false).length
            : 0,
        );
      } catch (err: any) {
        // axios surfaces an AbortController abort as ERR_CANCELED — ignore
        // those (the org-scope changed mid-fetch) but log everything else.
        if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return;
        logger.error('Dashboard fetch error:', err);
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [scopedOrgId],
  );

  useEffect(() => {
    // One AbortController per active scope. When scopedOrgId changes (or the
    // component unmounts), we abort any in-flight requests so a slow stale
    // response can't overwrite the fresh scope's data.
    const ac = new AbortController();
    fetchData(ac.signal);
    // 30s poll: SSE handles state-change pushes, so polling only fills in
    // flashes + feed health. Halving from 15s eased server load without
    // hurting perceived freshness.
    const interval = setInterval(() => fetchData(ac.signal), 30000);
    return () => {
      clearInterval(interval);
      ac.abort();
    };
  }, [fetchData]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchData();
  };

  // Demo locations participate in the risk engine but are hidden from the
  // dashboard unless the operator explicitly opts in. Counts and the map
  // both filter on the same `visibleLocations` array so the summary tiles
  // never reference rows the operator can't see in the grid below.
  const visibleLocations = showDemo ? locations : locations.filter((l) => !l.is_demo);
  const demoCount = locations.length - visibleLocations.length;

  // Counts derived from the *effective* state. A location with is_degraded=true
  // must NEVER be counted as ALL_CLEAR even if its `state` field still reads
  // ALL_CLEAR (transient on the server during recovery): operators read these
  // tiles as "X of Y safe right now" and a degraded site is by definition
  // unknown, not safe. Also reflected in StatusCard via the same predicate.
  const isDegradedOrNoFeed = (l: LocationStatus) => l.is_degraded || l.state === 'DEGRADED';
  const stopsCount = visibleLocations.filter(
    (l) => !isDegradedOrNoFeed(l) && (l.state === 'STOP' || l.state === 'HOLD'),
  ).length;
  const prepareCount = visibleLocations.filter(
    (l) => !isDegradedOrNoFeed(l) && l.state === 'PREPARE',
  ).length;
  const clearCount = visibleLocations.filter(
    (l) => !isDegradedOrNoFeed(l) && l.state === 'ALL_CLEAR',
  ).length;
  const degradedCount = visibleLocations.filter(isDegradedOrNoFeed).length;
  const totalFlashesNear = visibleLocations.reduce(
    (s, l) => s + (l.flashes_in_stop_radius || 0),
    0,
  );

  const saTime = nowSAST();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const wsConnected = useRealtimeConnection();

  return (
    <Box>
      <DataFreshnessBanner
        connected={wsConnected}
        dataAgeMinutes={health?.dataAgeMinutes ?? null}
      />
      {/* Visually-hidden aria-live region. Announces every risk-state change
          to screen readers without altering the visual layout. */}
      <Box
        aria-live="polite"
        role="status"
        sx={{
          position: 'absolute',
          width: 1,
          height: 1,
          margin: -1,
          padding: 0,
          overflow: 'hidden',
          clip: 'rect(0,0,0,0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        {announcement}
      </Box>
      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          mb: 3,
          gap: 1,
        }}
      >
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5, flexWrap: 'wrap' }}>
            <Typography variant="h4" sx={{ fontSize: { xs: 18, sm: 24 }, fontWeight: 700 }}>
              Live Dashboard
            </Typography>
            {stopsCount > 0 && (
              <Chip
                label={`${stopsCount} ACTIVE ALERT${stopsCount > 1 ? 'S' : ''}`}
                color="error"
                size="small"
                sx={{ fontWeight: 700, fontSize: 11, letterSpacing: 0.5 }}
              />
            )}
          </Box>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              flexWrap: 'wrap',
              fontSize: { xs: 11, sm: 14 },
            }}
          >
            <AccessTimeIcon sx={{ fontSize: 14 }} />
            {saTime} {displayZoneLabel()} •{' '}
            <Tooltip
              title={`${visibleLocations.length} enabled location${visibleLocations.length === 1 ? '' : 's'} shown above${demoCount > 0 ? ` · ${demoCount} demo hidden (toggle "Demo: shown" in the header)` : ''}${disabledCount > 0 ? ` · ${disabledCount} disabled (not evaluated by the risk engine)` : ''}.`}
            >
              <span style={{ cursor: 'help', textDecoration: 'underline dotted' }}>
                {visibleLocations.length} site{visibleLocations.length === 1 ? '' : 's'}
                {demoCount > 0 && <> (+{demoCount} demo hidden)</>}
                {disabledCount > 0 && <> (+{disabledCount} disabled)</>}
              </span>
            </Tooltip>{' '}
            •{' '}
            {flashes.length > 0
              ? `${flashes.length} flashes (30 min)`
              : afaPixels.length > 0
                ? 'Live AFA monitoring'
                : 'No recent lightning'}
            {health && (
              <>
                {' '}
                • <FeedTierLabel tier={health.feedTier} ageMin={health.dataAgeMinutes} />
              </>
            )}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexShrink: 0 }}>
          {/* Mode-only indicator (LIVE vs SIMULATED). Feed up/down lives in
              the top bar so we don't double-signal a single fact. */}
          {health?.mode === 'in-memory-mock' && (
            <Chip
              icon={<SignalCellularAltIcon />}
              label="SIMULATED"
              size="small"
              color="warning"
              variant="outlined"
              sx={{ fontWeight: 600, fontSize: 11, display: { xs: 'none', sm: 'flex' } }}
            />
          )}
          {locations.some((l) => l.is_demo) && (
            <Tooltip
              title={
                showDemo
                  ? 'Hide demo / test locations'
                  : 'Show demo / test locations alongside real sites'
              }
            >
              <Chip
                label={showDemo ? 'Demo: shown' : 'Demo: hidden'}
                size="small"
                color={showDemo ? 'primary' : 'default'}
                variant={showDemo ? 'filled' : 'outlined'}
                onClick={() =>
                  setShowDemo((prev) => {
                    const next = !prev;
                    localStorage.setItem('flashaware_show_demo', next ? '1' : '0');
                    return next;
                  })
                }
                sx={{
                  fontWeight: 600,
                  fontSize: 11,
                  display: { xs: 'none', sm: 'flex' },
                  cursor: 'pointer',
                }}
              />
            </Tooltip>
          )}
          <Tooltip title="Refresh now">
            <IconButton
              aria-label="Refresh"
              onClick={handleRefresh}
              size="small"
              sx={{
                animation: refreshing ? 'spin 1s linear infinite' : 'none',
                '@keyframes spin': { '100%': { transform: 'rotate(360deg)' } },
              }}
            >
              <RefreshIcon />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {refreshing && <LinearProgress sx={{ mb: 1, mt: -1, borderRadius: 1 }} />}

      {onboarding && <SetupChecklist state={onboarding} />}

      {/* Summary Stats */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr 1fr', sm: 'repeat(4, 1fr)' },
          gap: 2,
          mb: 3,
        }}
      >
        <StatCard
          icon={<WarningAmberIcon sx={{ fontSize: 28 }} />}
          label="STOP / HOLD"
          value={stopsCount}
          color={stopsCount > 0 ? '#d32f2f' : '#66bb6a'}
          sub={stopsCount > 0 ? 'Immediate action required' : 'No active alerts'}
        />
        <StatCard
          icon={<TrendingUpIcon sx={{ fontSize: 28 }} />}
          label="PREPARE"
          value={prepareCount}
          color={prepareCount > 0 ? '#fbc02d' : '#66bb6a'}
          sub="Heightened awareness"
        />
        <StatCard
          icon={<FlashOnIcon sx={{ fontSize: 28 }} />}
          label="Flashes Nearby"
          value={totalFlashesNear}
          color="#ff9800"
          sub="Within STOP radii"
        />
        <StatCard
          icon={<CheckCircleOutlineIcon sx={{ fontSize: 28 }} />}
          label="ALL CLEAR"
          value={clearCount}
          color="#2e7d32"
          sub={
            degradedCount > 0
              ? `of ${visibleLocations.length} sites (${degradedCount} no feed)`
              : `of ${visibleLocations.length} sites`
          }
        />
      </Box>

      {showNotifBanner && (
        <Alert
          severity="info"
          onClose={handleNotifBannerClose}
          action={
            <Button
              color="inherit"
              size="small"
              onClick={async () => {
                await Notification.requestPermission();
                // Either way (granted or denied), we don't need to nag again.
                localStorage.setItem('flashaware_notif_dismissed', '1');
                setShowNotifBanner(false);
              }}
            >
              Enable
            </Button>
          }
          sx={{ mb: 2 }}
        >
          Get desktop notifications when a site goes STOP — even when the tab is in the background.
        </Alert>
      )}

      {/* Status Cards */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1.5 }}>
        <Typography
          variant="h6"
          sx={{
            fontSize: 14,
            color: 'text.secondary',
            textTransform: 'uppercase',
            letterSpacing: 1,
          }}
        >
          <LocationOnIcon sx={{ fontSize: 16, verticalAlign: 'text-bottom', mr: 0.5 }} />
          Monitored Locations
        </Typography>
        <StateGlossaryButton />
      </Box>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', md: 'repeat(4, 1fr)' },
          gap: 2,
          mb: 3,
        }}
      >
        {loading ? (
          [1, 2, 3, 4].map((i) => (
            <Skeleton key={i} variant="rounded" height={180} sx={{ borderRadius: 3 }} />
          ))
        ) : visibleLocations.length === 0 ? (
          <Box sx={{ gridColumn: '1 / -1' }}>
            <EmptyState
              icon={<LocationOnIcon />}
              title={
                locations.length === 0 ? 'No locations configured yet' : 'All locations are demo'
              }
              description={
                locations.length === 0
                  ? 'Add your first monitored location to start tracking lightning risk.'
                  : 'Every location in this view is flagged as demo. Toggle "Demo: hidden" to show them, or add a real customer site.'
              }
              cta={{
                label: locations.length === 0 ? 'Add location' : 'Manage locations',
                onClick: () => navigate('/locations'),
                icon: <LocationOnIcon />,
              }}
            />
          </Box>
        ) : (
          visibleLocations.map((loc) => (
            <StatusCard key={loc.id} loc={loc} pulse={pulseId === loc.id} />
          ))
        )}
      </Box>

      {/* Map */}
      <Typography
        variant="h6"
        sx={{
          fontSize: 14,
          mb: 1.5,
          color: 'text.secondary',
          textTransform: 'uppercase',
          letterSpacing: 1,
        }}
      >
        <RadarIcon sx={{ fontSize: 16, verticalAlign: 'text-bottom', mr: 0.5 }} />
        Flash Activity Map
      </Typography>
      <DashboardMap
        visibleLocations={visibleLocations}
        flashes={flashes}
        stopsCount={stopsCount}
        fitVersion={fitVersion}
        onFitRequested={() => setFitVersion((v) => v + 1)}
        isMobile={isMobile}
      />
    </Box>
  );
}

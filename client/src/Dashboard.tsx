import React, { useState, useEffect, useCallback } from 'react';
import {
  Box, Card, CardContent, Typography, Chip, Skeleton, Tooltip,
  IconButton, Paper, Divider, LinearProgress, Alert, Button,
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
import { MapContainer, TileLayer, CircleMarker, Circle, Popup } from 'react-leaflet';
import { DateTime } from 'luxon';
import { getStatus, getFlashes, getHealth, getOnboardingState } from './api';
import { useOrgScope } from './OrgScope';
import { STATE_CONFIG, STATE_RANK, stateOf } from './states';
import { useRealtimeAlerts } from './useRealtimeAlerts';
import SetupChecklist from './components/SetupChecklist';
import EmptyState from './components/EmptyState';
import { useNavigate } from 'react-router-dom';
import type { LatLngExpression } from 'leaflet';

const SA_CENTER: LatLngExpression = [-28.5, 25.5];
const SA_ZOOM = 6;

interface LocationStatus {
  id: string;
  name: string;
  site_type: string;
  lng: number;
  lat: number;
  state: string | null;
  reason: any;
  evaluated_at: string | null;
  flashes_in_stop_radius: number | null;
  flashes_in_prepare_radius: number | null;
  nearest_flash_km: number | null;
  data_age_sec: number | null;
  is_degraded: boolean | null;
  stop_radius_km?: number;
  prepare_radius_km?: number;
}

interface Flash {
  flash_id: number;
  flash_time_utc: string;
  latitude: number;
  longitude: number;
  radiance: number | null;
  duration_ms: number | null;
  filter_confidence: number | null;
}

function formatSAST(utcStr: string | null): string {
  if (!utcStr) return '—';
  return DateTime.fromISO(utcStr, { zone: 'utc' })
    .setZone('Africa/Johannesburg')
    .toFormat('HH:mm:ss dd LLL');
}

function timeAgo(utcStr: string | null): string {
  if (!utcStr) return '—';
  const diff = DateTime.utc().diff(DateTime.fromISO(utcStr, { zone: 'utc' }), ['minutes', 'seconds']);
  if (diff.minutes > 0) return `${Math.floor(diff.minutes)}m ${Math.floor(diff.seconds % 60)}s ago`;
  return `${Math.floor(diff.seconds)}s ago`;
}

// Summary stat card
function StatCard({ icon, label, value, color, sub }: { icon: React.ReactElement; label: string; value: string | number; color: string; sub?: string }) {
  return (
    <Paper sx={{
      p: { xs: 1.5, sm: 2 }, bgcolor: 'rgba(255,255,255,0.03)', borderLeft: `3px solid ${color}`,
      display: 'flex', alignItems: 'center', gap: { xs: 1, sm: 2 }, transition: 'all 0.2s',
      '&:hover': { bgcolor: 'rgba(255,255,255,0.06)' }, overflow: 'hidden',
    }}>
      <Box sx={{ color, display: 'flex', flexShrink: 0 }}>{icon}</Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="body2" color="text.secondary" noWrap sx={{ fontSize: { xs: 9, sm: 11 }, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          {label}
        </Typography>
        <Typography variant="h6" sx={{ fontSize: { xs: 18, sm: 20 }, fontWeight: 700, lineHeight: 1.2 }}>{value}</Typography>
        {sub && <Typography variant="body2" color="text.secondary" noWrap sx={{ fontSize: { xs: 9, sm: 11 } }}>{sub}</Typography>}
      </Box>
    </Paper>
  );
}

// Status card for a single location
function StatusCard({ loc, pulse }: { loc: LocationStatus; pulse?: boolean }) {
  const cfg = STATE_CONFIG[stateOf(loc.state)];
  const reasonText = typeof loc.reason === 'object' ? loc.reason?.reason : loc.reason;
  const isUrgent = loc.state === 'STOP' || loc.state === 'HOLD';

  // Pulse takes precedence over the urgent steady-glow so the operator
  // notices the moment a state change lands. Both keyframe sets coexist
  // in the sx so the browser can run whichever animation is currently set.
  return (
    <Card sx={{
      border: `1px solid ${cfg.color}55`,
      bgcolor: cfg.bg,
      transition: 'all 0.3s ease',
      position: 'relative',
      overflow: 'hidden',
      '&:hover': { transform: 'translateY(-3px)', boxShadow: `0 8px 30px ${cfg.color}30` },
      ...(pulse
        ? {
            animation: 'flashalert 1s ease-in-out 2',
            '@keyframes flashalert': {
              '0%, 100%': { boxShadow: 'none' },
              '50%': { boxShadow: '0 0 0 4px rgba(211,47,47,0.6)' },
            },
          }
        : isUrgent && {
            animation: 'urgentGlow 2s ease-in-out infinite',
            '@keyframes urgentGlow': {
              '0%, 100%': { boxShadow: `0 0 10px ${cfg.color}20` },
              '50%': { boxShadow: `0 0 25px ${cfg.color}40` },
            },
          }),
    }}>
      {/* Top accent bar */}
      <Box sx={{ height: 3, bgcolor: cfg.color, borderRadius: '12px 12px 0 0' }} />
      <CardContent sx={{ pt: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1.5, gap: 1 }}>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="subtitle2" color="text.secondary" sx={{
              textTransform: 'uppercase', fontSize: 10, letterSpacing: 1.2, mb: 0.3,
            }}>
              {loc.site_type?.replace('_', ' ')}
            </Typography>
            <Typography variant="h6" sx={{ fontSize: 15, fontWeight: 600, lineHeight: 1.2 }} noWrap>
              {loc.name}
            </Typography>
          </Box>
          <Box sx={{
            display: 'flex', alignItems: 'center', gap: 0.5,
            bgcolor: cfg.color, color: cfg.textColor, px: 1, py: 0.4,
            borderRadius: 2, fontWeight: 700, fontSize: 10, letterSpacing: 0.5,
            whiteSpace: 'nowrap', flexShrink: 0,
            ...(isUrgent && {
              animation: 'pulse 1.5s ease-in-out infinite',
              '@keyframes pulse': {
                '0%, 100%': { opacity: 1 },
                '50%': { opacity: 0.7 },
              },
            }),
          }}>
            <span style={{ fontSize: 10 }}>{cfg.emoji}</span> {cfg.label}
          </Box>
        </Box>

        {/* Metrics row */}
        <Box sx={{
          display: 'flex', gap: 0.5, flexWrap: 'wrap',
          p: 1, borderRadius: 1.5, bgcolor: 'rgba(0,0,0,0.15)',
        }}>
          {loc.nearest_flash_km !== null && (
            <Tooltip title="Nearest flash distance" arrow>
              <Chip
                icon={<FlashOnIcon sx={{ fontSize: '14px !important' }} />}
                label={`${loc.nearest_flash_km.toFixed(1)} km`}
                size="small"
                sx={{
                  height: 24, fontSize: 11, fontWeight: 600,
                  bgcolor: loc.nearest_flash_km < 10 ? 'rgba(211,47,47,0.25)' : 'rgba(255,255,255,0.08)',
                  color: loc.nearest_flash_km < 10 ? '#ff6659' : 'inherit',
                  '& .MuiChip-icon': { color: loc.nearest_flash_km < 10 ? '#ff6659' : cfg.color },
                }}
              />
            </Tooltip>
          )}
          {loc.flashes_in_stop_radius !== null && (
            <Tooltip title={`${loc.flashes_in_stop_radius} flash(es) in STOP radius`} arrow>
              <Chip
                icon={<RadarIcon sx={{ fontSize: '14px !important' }} />}
                label={`${loc.flashes_in_stop_radius} in zone`}
                size="small"
                sx={{ height: 24, fontSize: 11, bgcolor: 'rgba(255,255,255,0.08)', '& .MuiChip-icon': { color: '#ef5350' } }}
              />
            </Tooltip>
          )}
          {loc.evaluated_at && (
            <Tooltip title={`Evaluated: ${formatSAST(loc.evaluated_at)} SAST`} arrow>
              <Chip
                icon={<AccessTimeIcon sx={{ fontSize: '14px !important' }} />}
                label={timeAgo(loc.evaluated_at)}
                size="small"
                sx={{ height: 24, fontSize: 11, bgcolor: 'rgba(255,255,255,0.08)', '& .MuiChip-icon': { color: 'text.secondary' } }}
              />
            </Tooltip>
          )}
        </Box>

        {reasonText && (
          <Typography variant="body2" color="text.secondary" sx={{
            mt: 1.5, fontSize: 11, lineHeight: 1.6,
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>
            {reasonText}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const { scopedOrgId } = useOrgScope();
  const navigate = useNavigate();
  const [locations, setLocations] = useState<LocationStatus[]>([]);
  const [flashes, setFlashes] = useState<Flash[]>([]);
  const [health, setHealth] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pulseId, setPulseId] = useState<string | null>(null);
  const [showNotifBanner, setShowNotifBanner] = useState(false);
  const [onboarding, setOnboarding] = useState<{ hasLocation: boolean; hasRecipient: boolean; hasVerifiedPhone: boolean } | null>(null);

  useEffect(() => {
    getOnboardingState().then(r => setOnboarding(r.data)).catch(() => setOnboarding(null));
  }, [scopedOrgId]);

  useEffect(() => {
    // Ask once. Browser remembers the answer; if denied, we silently skip.
    if ('Notification' in window && Notification.permission === 'default') {
      setShowNotifBanner(true);
    }
  }, []);

  // Real-time alert subscription. We optimistically merge the new state into
  // local `locations` so the operator sees the change BEFORE the next 15s
  // poll, then trigger a 4s pulse. Audio fires only on worsening (lower
  // STATE_RANK) — improvements are silent so we don't desensitise operators.
  useRealtimeAlerts((alert) => {
    setLocations((prev) => {
      const existing = prev.find((l) => l.id === alert.locationId);
      const prevRank = STATE_RANK[(existing?.state ?? 'ALL_CLEAR') as keyof typeof STATE_RANK] ?? 5;
      const newRank = STATE_RANK[alert.state as keyof typeof STATE_RANK] ?? 5;
      const worsened = newRank < prevRank;

      if (worsened) {
        try {
          const audio = new Audio('/alert.mp3');
          audio.volume = 0.5;
          audio.play().catch(() => { /* autoplay blocked or asset missing — silent is fine */ });
        } catch (_) { /* no audio support */ }

        if (worsened && Notification.permission === 'granted' && document.hidden) {
          new Notification('FlashAware: ' + alert.state, {
            body: `${alert.locationName}: ${alert.reason}`,
            tag: alert.locationId,        // de-dup multiple events for same site
            requireInteraction: alert.state === 'STOP',
          });
        }
      }

      return prev.map((l) =>
        l.id === alert.locationId ? { ...l, state: alert.state } : l
      );
    });

    setPulseId(alert.locationId);
    setTimeout(
      () => setPulseId((curr) => (curr === alert.locationId ? null : curr)),
      4000
    );
  });

  const fetchData = useCallback(async () => {
    try {
      const [statusRes, flashRes, healthRes] = await Promise.all([
        getStatus(scopedOrgId ?? undefined),
        getFlashes({ minutes: 30 }),
        getHealth(),
      ]);
      setLocations(statusRes.data);
      setFlashes(flashRes.data);
      setHealth(healthRes.data);
    } catch (err) {
      console.error('Dashboard fetch error:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [scopedOrgId]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleRefresh = () => { setRefreshing(true); fetchData(); };

  const stopsCount = locations.filter(l => l.state === 'STOP' || l.state === 'HOLD').length;
  const prepareCount = locations.filter(l => l.state === 'PREPARE').length;
  const clearCount = locations.filter(l => l.state === 'ALL_CLEAR').length;
  const totalFlashesNear = locations.reduce((s, l) => s + (l.flashes_in_stop_radius || 0), 0);

  const saTime = DateTime.utc().setZone('Africa/Johannesburg').toFormat('HH:mm:ss');

  return (
    <Box>
      {/* Header */}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-start', mb: 3, gap: 1 }}>
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
                sx={{
                  fontWeight: 700, fontSize: 11, letterSpacing: 0.5,
                  animation: 'pulse 1.5s ease-in-out infinite',
                  '@keyframes pulse': { '0%, 100%': { opacity: 1 }, '50%': { opacity: 0.6 } },
                }}
              />
            )}
          </Box>
          <Typography variant="body2" color="text.secondary" sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap', fontSize: { xs: 11, sm: 14 } }}>
            <AccessTimeIcon sx={{ fontSize: 14 }} />
            {saTime} SAST • {locations.length} sites • {flashes.length} flashes (30 min)
            {health && <> • Feed: {health.dataAgeMinutes ?? '?'} min old</>}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexShrink: 0 }}>
          <Chip
            icon={<SignalCellularAltIcon />}
            label={health?.mode === 'live-eumetsat' ? (health?.feedHealthy ? 'LIVE EUMETSAT' : 'FEED OUTAGE') : (health?.feedHealthy ? 'SIMULATED' : 'FEED OUTAGE')}
            size="small"
            color={health?.feedHealthy ? 'success' : 'error'}
            variant="outlined"
            sx={{ fontWeight: 600, fontSize: 11, display: { xs: 'none', sm: 'flex' } }}
          />
          <Tooltip title="Refresh now">
            <IconButton aria-label="Refresh" onClick={handleRefresh} size="small"
              sx={{ animation: refreshing ? 'spin 1s linear infinite' : 'none',
                '@keyframes spin': { '100%': { transform: 'rotate(360deg)' } } }}>
              <RefreshIcon />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {refreshing && <LinearProgress sx={{ mb: 1, mt: -1, borderRadius: 1 }} />}

      {onboarding && <SetupChecklist state={onboarding} />}

      {/* Summary Stats */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', sm: 'repeat(4, 1fr)' }, gap: 2, mb: 3 }}>
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
          sub={`of ${locations.length} sites`}
        />
      </Box>

      {showNotifBanner && (
        <Alert
          severity="info"
          onClose={() => setShowNotifBanner(false)}
          action={
            <Button color="inherit" size="small" onClick={async () => {
              const result = await Notification.requestPermission();
              setShowNotifBanner(false);
              if (result === 'granted') localStorage.setItem('flashaware_notif_ok', '1');
            }}>
              Enable
            </Button>
          }
          sx={{ mb: 2 }}
        >
          Get desktop notifications when a site goes STOP — even when the tab is in the background.
        </Alert>
      )}

      {/* Status Cards */}
      <Typography variant="h6" sx={{ fontSize: 14, mb: 1.5, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
        <LocationOnIcon sx={{ fontSize: 16, verticalAlign: 'text-bottom', mr: 0.5 }} />
        Monitored Locations
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', md: 'repeat(4, 1fr)' }, gap: 2, mb: 3 }}>
        {loading ? (
          [1, 2, 3, 4].map(i => (
            <Skeleton key={i} variant="rounded" height={180} sx={{ borderRadius: 3 }} />
          ))
        ) : locations.length === 0 ? (
          <Box sx={{ gridColumn: '1 / -1' }}>
            <EmptyState
              icon={<LocationOnIcon />}
              title="No locations configured yet"
              description="Add your first monitored location to start tracking lightning risk."
              cta={{ label: 'Add location', onClick: () => navigate('/locations'), icon: <LocationOnIcon /> }}
            />
          </Box>
        ) : (
          locations.map(loc => (
            <StatusCard key={loc.id} loc={loc} pulse={pulseId === loc.id} />
          ))
        )}
      </Box>

      {/* Map */}
      <Typography variant="h6" sx={{ fontSize: 14, mb: 1.5, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
        <RadarIcon sx={{ fontSize: 16, verticalAlign: 'text-bottom', mr: 0.5 }} />
        Flash Activity Map
      </Typography>
      <Card sx={{ overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)' }}>
        <Box sx={{ height: { xs: 320, sm: 420, md: 520 }, position: 'relative' }}>
          {/* Flash counter overlay */}
          <Box sx={{
            position: 'absolute', top: 8, right: 8, zIndex: 1000,
            bgcolor: 'rgba(10,25,41,0.85)', backdropFilter: 'blur(8px)',
            borderRadius: 2, px: { xs: 1.5, sm: 2 }, py: { xs: 0.5, sm: 1 }, display: 'flex', gap: { xs: 1.5, sm: 2 },
            border: '1px solid rgba(255,255,255,0.1)',
          }}>
            <Box sx={{ textAlign: 'center' }}>
              <Typography sx={{ fontSize: 18, fontWeight: 700, color: '#ff9800' }}>{flashes.length}</Typography>
              <Typography sx={{ fontSize: 9, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 0.5 }}>Flashes</Typography>
            </Box>
            <Divider orientation="vertical" flexItem />
            <Box sx={{ textAlign: 'center' }}>
              <Typography sx={{ fontSize: 18, fontWeight: 700, color: stopsCount > 0 ? '#d32f2f' : '#66bb6a' }}>{stopsCount}</Typography>
              <Typography sx={{ fontSize: 9, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 0.5 }}>Alerts</Typography>
            </Box>
          </Box>

          <MapContainer
            center={SA_CENTER}
            zoom={SA_ZOOM}
            style={{ height: '100%', width: '100%' }}
            scrollWheelZoom={true}
          >
            <TileLayer
              attribution='&copy; <a href="https://carto.com/">CARTO</a>'
              url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            />

            {/* Location markers with buffer rings */}
            {locations.map(loc => {
              const cfg = STATE_CONFIG[stateOf(loc.state)];
              const pos: LatLngExpression = [loc.lat, loc.lng];
              return (
                <React.Fragment key={loc.id}>
                  <Circle center={pos}
                    radius={(loc.prepare_radius_km || 20) * 1000}
                    pathOptions={{ color: '#fbc02d', weight: 1, opacity: 0.25, fillOpacity: 0.04, dashArray: '5 5' }} />
                  <Circle center={pos}
                    radius={(loc.stop_radius_km || 10) * 1000}
                    pathOptions={{ color: '#d32f2f', weight: 1.5, opacity: 0.4, fillOpacity: 0.06 }} />
                  <CircleMarker center={pos} radius={9}
                    pathOptions={{ color: '#fff', fillColor: cfg.color, fillOpacity: 1, weight: 2 }}>
                    <Popup>
                      <div style={{ minWidth: 160 }}>
                        <strong style={{ fontSize: 14 }}>{loc.name}</strong><br />
                        <span style={{ color: cfg.color, fontWeight: 700 }}>{cfg.emoji} {cfg.label}</span><br />
                        {loc.nearest_flash_km !== null && <span>Nearest flash: <strong>{loc.nearest_flash_km.toFixed(1)} km</strong><br /></span>}
                        {loc.flashes_in_stop_radius !== null && <span>In STOP zone: <strong>{loc.flashes_in_stop_radius}</strong><br /></span>}
                        {loc.evaluated_at && <span style={{ fontSize: 11, color: '#999' }}>Updated: {formatSAST(loc.evaluated_at)} SAST</span>}
                      </div>
                    </Popup>
                  </CircleMarker>
                </React.Fragment>
              );
            })}

            {/* Flash events */}
            {flashes.map((f, idx) => {
              const age = DateTime.utc().diff(DateTime.fromISO(f.flash_time_utc, { zone: 'utc' }), 'minutes').minutes;
              const opacity = Math.max(0.25, 1 - age / 30);
              const size = Math.max(3, 6 - age / 10);
              const isRecent = age < 5;
              return (
                <CircleMarker
                  key={`${f.flash_id}-${idx}`}
                  center={[f.latitude, f.longitude]}
                  radius={size}
                  pathOptions={{
                    color: isRecent ? '#fff' : '#ffeb3b',
                    fillColor: isRecent ? '#ff5722' : '#ff9800',
                    fillOpacity: opacity,
                    weight: isRecent ? 2 : 1,
                    opacity: opacity,
                  }}
                >
                  <Popup>
                    <div style={{ minWidth: 140 }}>
                      <strong>Flash #{f.flash_id}</strong><br />
                      <span style={{ fontSize: 12 }}>{formatSAST(f.flash_time_utc)} SAST</span><br />
                      <span style={{ fontSize: 12 }}>{timeAgo(f.flash_time_utc)}</span><br />
                      {f.radiance != null && <span style={{ fontSize: 12 }}>Radiance: {f.radiance.toFixed(2)}<br /></span>}
                      {f.duration_ms != null && <span style={{ fontSize: 12 }}>Duration: {f.duration_ms} ms</span>}
                    </div>
                  </Popup>
                </CircleMarker>
              );
            })}
          </MapContainer>
        </Box>
      </Card>
    </Box>
  );
}

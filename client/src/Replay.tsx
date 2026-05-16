import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Grid,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Slider,
  IconButton,
  Chip,
  Button,
  Paper,
  LinearProgress,
  Tooltip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TableContainer,
  Divider,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import SkipNextIcon from '@mui/icons-material/SkipNext';
import SkipPreviousIcon from '@mui/icons-material/SkipPrevious';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import FlashOnIcon from '@mui/icons-material/FlashOn';
import TimelineIcon from '@mui/icons-material/Timeline';
import SpeedIcon from '@mui/icons-material/Speed';
import NotificationsIcon from '@mui/icons-material/Notifications';
import { CircleMarker, Circle, Popup, useMap } from 'react-leaflet';
import { useSearchParams } from 'react-router-dom';
import { getLocations, getReplay } from './api';
import { useOrgScope } from './OrgScope';
import { formatSAST } from './utils/format';
import { MapBase } from './components/MapBase';
import { STATE_CONFIG, stateOf } from './states';
import InfoTip from './components/InfoTip';
import { helpBody, helpTitle } from './help/copy';
import type { LatLngExpression } from 'leaflet';
import { logger } from './utils/logger';
import { CellsByIncidenceLayer } from './MapLayers/CellsByIncidenceLayer';
import type { AfaPixel } from './MapLayers/useAfaPixels';

type Zone = 'STOP' | 'PREPARE' | 'OUTSIDE';

function classifyZone(distance_km: number, stop_km: number, prepare_km: number): Zone {
  if (distance_km <= stop_km) return 'STOP';
  if (distance_km <= prepare_km) return 'PREPARE';
  return 'OUTSIDE';
}

interface LocationOption {
  id: string;
  name: string;
  lat: number;
  lng: number;
  current_state: string | null;
  stop_radius_km: number;
  prepare_radius_km: number;
  stop_window_min?: number;
  prepare_window_min?: number;
}

interface ReplayState {
  id: number;
  location_id: string;
  state: string;
  previous_state: string | null;
  reason: any;
  evaluated_at: string;
  flashes_in_stop_radius: number;
  flashes_in_prepare_radius: number;
  nearest_flash_km: number | null;
  data_age_sec: number;
  is_degraded: boolean;
}

interface ReplayFlash {
  flash_id: number;
  flash_time_utc: string;
  latitude: number;
  longitude: number;
  radiance: number | null;
  duration_ms: number | null;
  distance_km: number;
}

interface TriggeredAlert {
  alert_id: number;
  sent_at: string;
  transition_id: number;
}

// Auto-zoom the replay map so the prepare-radius ring is fully visible.
// Hardcoded zoom=10 collapsed any radius above ~50 km off-screen — a 150 km
// PREPARE ring rendered far outside the viewport, which looked like the
// renderer had broken. We compute a bounding box from the centroid + radius
// and let Leaflet fit it.
function FitToRadius({
  lat,
  lng,
  radiusKm,
  version,
}: {
  lat: number;
  lng: number;
  radiusKm: number;
  version: number;
}) {
  const map = useMap();
  useEffect(() => {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || radiusKm <= 0) return;
    // Latitude: 1° ≈ 111 km. Longitude scales by cos(lat). We add ~10% padding
    // so the ring isn't flush against the viewport edge.
    const padded = radiusKm * 1.1;
    const dLat = padded / 111;
    const dLng = padded / (111 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
    map.fitBounds(
      [
        [lat - dLat, lng - dLng],
        [lat + dLat, lng + dLng],
      ],
      { padding: [20, 20] },
    );
    // version dep lets the parent force a refit (e.g. on selection change).
  }, [map, lat, lng, radiusKm, version]);
  return null;
}

export default function Replay() {
  const { scopedOrgId } = useOrgScope();
  const [searchParams, setSearchParams] = useSearchParams();
  const [locations, setLocations] = useState<LocationOption[]>([]);
  // Initialise from ?locationId=<uuid> so a Dashboard StatusCard click lands
  // here pre-selected. Falls back to the first location once we fetch.
  const [selectedLocation, setSelectedLocation] = useState<string>(
    searchParams.get('locationId') ?? '',
  );
  const [lookbackHours, setLookbackHours] = useState<number>(1);
  const [states, setStates] = useState<ReplayState[]>([]);
  const [flashes, setFlashes] = useState<ReplayFlash[]>([]);
  const [afaPixels, setAfaPixels] = useState<AfaPixel[]>([]);
  const [lightningSource, setLightningSource] = useState<'lfl' | 'afa'>('lfl');
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [replayLoc, setReplayLoc] = useState<{
    stop_radius_km: number;
    prepare_radius_km: number;
    stop_window_min: number;
    prepare_window_min: number;
  } | null>(null);
  // Staged for Tasks 3 (legend + show-wider toggle) and 4 (alert-bell timeline).
  // Set here so the response hydration in loadReplay is colocated.
  const [flashesTruncated, setFlashesTruncated] = useState(false);
  const [triggeredAlerts, setTriggeredAlerts] = useState<TriggeredAlert[]>([]);
  const [showWiderView, setShowWiderView] = useState(false);
  // Tile-load state moved into MapBase — Replay no longer needs its own.

  // Playback state
  const [currentIndex, setCurrentIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  // Speed multiplier: 1x = one step per second. 2x = twice as fast.
  const [speed, setSpeed] = useState(1);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch locations on mount or when scope changes
  useEffect(() => {
    getLocations(scopedOrgId ?? undefined)
      .then((res) => {
        setLocations(res.data);
        // If the currently selected location isn't in the new scope, pick the first.
        const haveCurrent = res.data.some((l: any) => l.id === selectedLocation);
        if (!haveCurrent && res.data.length > 0) setSelectedLocation(res.data[0].id);
        if (res.data.length === 0) setSelectedLocation('');
      })
      .catch((err) => logger.error(err));
  }, [scopedOrgId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Once we've used the deep-link param, strip it from the URL — otherwise
  // a refresh keeps re-pinning the selection and the Locations dropdown
  // change wouldn't survive a back/forward navigation.
  useEffect(() => {
    if (searchParams.has('locationId') && selectedLocation) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete('locationId');
          return next;
        },
        { replace: true },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLocation]);

  // Load replay data
  const loadReplay = useCallback(async () => {
    if (!selectedLocation) return;
    setLoading(true);
    setPlaying(false);
    try {
      const res = await getReplay(selectedLocation, lookbackHours);
      const data = res.data;
      const src: 'lfl' | 'afa' = data.source === 'afa' ? 'afa' : 'lfl';
      setLightningSource(src);
      setStates(data.states || []);
      setTriggeredAlerts(data.triggered_alerts || []);
      setReplayLoc(data.location || null);
      if (src === 'afa') {
        // Convert GeoJSON features to AfaPixel shape
        const pixels: AfaPixel[] = (data.features || []).map((f: any) => ({
          observed_at_utc: f.properties.observed_at_utc,
          pixel_lat: f.properties.pixel_lat,
          pixel_lon: f.properties.pixel_lon,
          flash_count: f.properties.flash_count,
          geometry: f.geometry,
        }));
        setAfaPixels(pixels);
        setFlashes([]);
        setFlashesTruncated(false);
      } else {
        setFlashes(data.flashes || []);
        setFlashesTruncated(Boolean(data.flashes_truncated));
        setAfaPixels([]);
      }
      setCurrentIndex(0);
      setLoaded(true);
    } catch (err) {
      logger.error('Replay fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, [selectedLocation, lookbackHours]);

  // Playback interval. speed=1 → 1000ms per step; speed=4 → 250ms per step.
  useEffect(() => {
    if (playing && states.length > 0) {
      intervalRef.current = setInterval(() => {
        setCurrentIndex((prev) => {
          if (prev >= states.length - 1) {
            setPlaying(false);
            return prev;
          }
          return prev + 1;
        });
      }, 1000 / speed);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [playing, speed, states.length]);

  // Auto-load whenever location or lookback changes — removes the redundant
  // "pick params, then click Load" step. Debounced via the dependency array.
  useEffect(() => {
    if (selectedLocation) loadReplay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLocation, lookbackHours]);

  // Keyboard shortcuts: Space=play/pause, ←/→=step, Home/End=jump.
  // Bind to window so they work even when focus isn't inside the player.
  useEffect(() => {
    if (!loaded || states.length === 0) return;
    const handler = (e: KeyboardEvent) => {
      // Skip when user is typing in a form field
      const t = e.target as HTMLElement;
      if (t && /INPUT|TEXTAREA|SELECT/.test(t.tagName)) return;
      if (e.key === ' ') {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === 'ArrowLeft') {
        setPlaying(false);
        setCurrentIndex((i) => Math.max(0, i - 1));
      } else if (e.key === 'ArrowRight') {
        setPlaying(false);
        setCurrentIndex((i) => Math.min(states.length - 1, i + 1));
      } else if (e.key === 'Home') {
        setPlaying(false);
        setCurrentIndex(0);
      } else if (e.key === 'End') {
        setPlaying(false);
        setCurrentIndex(states.length - 1);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [loaded, states.length]);

  const currentState = states[currentIndex] || null;
  const currentTime = currentState ? new Date(currentState.evaluated_at).getTime() : 0;

  // Mark a state-transition timeline segment if an alert was dispatched at it.
  // `triggered_alerts` rows arrive with `transition_id` matching `risk_states.id`.
  const transitionHasAlert = new Set<number>();
  states.forEach((s) => {
    if (triggeredAlerts.some((a) => a.transition_id === s.id)) {
      transitionHasAlert.add(s.id);
    }
  });

  const loc = locations.find((l) => l.id === selectedLocation);
  const center: LatLngExpression = loc ? [loc.lat, loc.lng] : [-26.2, 28.0];

  // Use the risk engine's actual evaluation window (stop_window_min) so flash list
  // matches exactly what the engine counted when it produced this state
  const evalWindowMs = (replayLoc?.stop_window_min ?? 15) * 60 * 1000;
  const visibleFlashes = flashes.filter((f) => {
    const ft = new Date(f.flash_time_utc).getTime();
    return ft <= currentTime && ft >= currentTime - evalWindowMs;
  });
  // AFA: filter pixels to the current evaluation window using observed_at_utc
  const visibleAfaPixels = afaPixels.filter((p) => {
    const pt = new Date(p.observed_at_utc).getTime();
    return pt <= currentTime && pt >= currentTime - evalWindowMs;
  });

  const stopRadiusKm = replayLoc?.stop_radius_km ?? loc?.stop_radius_km ?? 10;
  const prepareRadiusKm = replayLoc?.prepare_radius_km ?? loc?.prepare_radius_km ?? 25;

  // Classify each flash by which zone it falls in
  const flashesWithZone = visibleFlashes.map((f) => ({
    ...f,
    zone: classifyZone(f.distance_km, stopRadiusKm, prepareRadiusKm),
  }));

  const reasonText = currentState?.reason
    ? typeof currentState.reason === 'object'
      ? currentState.reason.reason
      : currentState.reason
    : '—';

  const cfg = STATE_CONFIG[stateOf(currentState?.state)];

  return (
    <Box>
      <Typography variant="h4" sx={{ fontSize: { xs: 18, sm: 24 }, mb: 0.5 }}>
        Event Replay
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Step through historical risk state transitions and flash events on a timeline.
      </Typography>

      {/* Controls */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Grid container spacing={2} alignItems="center">
            <Grid item xs={12} sm={4}>
              <FormControl fullWidth size="small">
                <InputLabel>Location</InputLabel>
                <Select
                  value={selectedLocation}
                  label="Location"
                  onChange={(e) => {
                    setSelectedLocation(e.target.value);
                    setLoaded(false);
                  }}
                >
                  {locations.map((l) => (
                    <MenuItem key={l.id} value={l.id}>
                      {l.name}
                      {l.current_state && (
                        <Chip
                          label={l.current_state}
                          size="small"
                          sx={{
                            ml: 1,
                            height: 20,
                            fontSize: 10,
                            fontWeight: 700,
                            bgcolor: STATE_CONFIG[stateOf(l.current_state)].color,
                            color: '#fff',
                          }}
                        />
                      )}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={6} sm={3}>
              <Box sx={{ position: 'relative' }}>
                <FormControl fullWidth size="small">
                  <InputLabel>Lookback</InputLabel>
                  <Select
                    value={lookbackHours}
                    label="Lookback"
                    onChange={(e) => {
                      setLookbackHours(+e.target.value);
                      setLoaded(false);
                    }}
                  >
                    <MenuItem value={1}>1 hour</MenuItem>
                    <MenuItem value={2}>2 hours</MenuItem>
                    <MenuItem value={4}>4 hours</MenuItem>
                    <MenuItem value={8}>8 hours</MenuItem>
                    <MenuItem value={24}>24 hours</MenuItem>
                  </Select>
                </FormControl>
                <Box sx={{ position: 'absolute', top: -10, right: -8 }}>
                  <InfoTip
                    inline
                    title={helpTitle('replay_lookback')}
                    body={helpBody('replay_lookback')}
                  />
                </Box>
              </Box>
            </Grid>
            <Grid item xs={6} sm={3}>
              <Box sx={{ position: 'relative' }}>
                <FormControl fullWidth size="small">
                  <InputLabel>Speed</InputLabel>
                  <Select value={speed} label="Speed" onChange={(e) => setSpeed(+e.target.value)}>
                    <MenuItem value={0.5}>0.5x</MenuItem>
                    <MenuItem value={1}>1x</MenuItem>
                    <MenuItem value={2}>2x</MenuItem>
                    <MenuItem value={4}>4x</MenuItem>
                  </Select>
                </FormControl>
                <Box sx={{ position: 'absolute', top: -10, right: -8 }}>
                  <InfoTip
                    inline
                    title={helpTitle('replay_speed')}
                    body={helpBody('replay_speed')}
                  />
                </Box>
              </Box>
            </Grid>
            <Grid item xs={12} sm={2}>
              <Button
                fullWidth
                variant="contained"
                onClick={loadReplay}
                disabled={!selectedLocation || loading}
              >
                {loading ? 'Loading…' : 'Refresh'}
              </Button>
            </Grid>
          </Grid>
        </CardContent>
      </Card>

      {loading && <LinearProgress sx={{ mb: 2 }} />}

      {loaded && states.length === 0 && (
        <Card sx={{ textAlign: 'center', py: 6 }}>
          <TimelineIcon sx={{ fontSize: 48, color: 'text.secondary', mb: 1 }} />
          <Typography color="text.secondary">
            No state transitions found for this location in the last {lookbackHours} hour(s).
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            The risk engine may need more time to generate transitions. Try a longer lookback
            window.
          </Typography>
        </Card>
      )}

      {loaded && states.length > 0 && (
        <>
          {/* Current state banner */}
          <Card sx={{ mb: 2, border: `2px solid ${cfg.color}`, bgcolor: cfg.bg }}>
            <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
              <Grid container spacing={2} alignItems="center">
                <Grid item xs={12} sm={4}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                    <Box
                      sx={{
                        width: 44,
                        height: 44,
                        borderRadius: '50%',
                        bgcolor: cfg.color,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 22,
                      }}
                    >
                      {cfg.emoji}
                    </Box>
                    <Box>
                      <Typography variant="h6" sx={{ fontSize: 18, lineHeight: 1.2 }}>
                        {cfg.label}
                      </Typography>
                      <Typography variant="body2" color="text.secondary" sx={{ fontSize: 12 }}>
                        Step {currentIndex + 1} of {states.length}
                      </Typography>
                    </Box>
                  </Box>
                </Grid>
                <Grid item xs={12} sm={4}>
                  <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11 }}>
                    TIME (SAST)
                  </Typography>
                  <Typography variant="body1" sx={{ fontFamily: 'monospace', fontSize: 15 }}>
                    {formatSAST(currentState!.evaluated_at)}
                  </Typography>
                </Grid>
                <Grid item xs={12} sm={4}>
                  <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                    <Box>
                      <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11 }}>
                        STOP FLASHES
                      </Typography>
                      <Typography variant="body1" fontWeight={600}>
                        {currentState!.flashes_in_stop_radius}
                      </Typography>
                    </Box>
                    <Box>
                      <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11 }}>
                        PREPARE FLASHES
                      </Typography>
                      <Typography variant="body1" fontWeight={600}>
                        {currentState!.flashes_in_prepare_radius}
                      </Typography>
                    </Box>
                    <Box>
                      <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11 }}>
                        NEAREST
                      </Typography>
                      <Typography variant="body1" fontWeight={600}>
                        {currentState!.nearest_flash_km != null
                          ? `${currentState!.nearest_flash_km.toFixed(1)} km`
                          : '—'}
                      </Typography>
                    </Box>
                  </Box>
                </Grid>
              </Grid>
            </CardContent>
          </Card>

          {/* Reason */}
          <Card sx={{ mb: 2 }}>
            <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
              <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11, mb: 0.5 }}>
                REASON
              </Typography>
              <Typography variant="body2">{reasonText}</Typography>
            </CardContent>
          </Card>

          {/* Playback controls + timeline */}
          <Card sx={{ mb: 3 }}>
            <CardContent>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: { xs: 0.5, sm: 1 },
                  mb: 2,
                  flexWrap: 'wrap',
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <Tooltip title="Restart">
                    <IconButton
                      size="small"
                      onClick={() => {
                        setPlaying(false);
                        setCurrentIndex(0);
                      }}
                    >
                      <RestartAltIcon />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Previous step">
                    <IconButton
                      size="small"
                      onClick={() => setCurrentIndex(Math.max(0, currentIndex - 1))}
                      disabled={currentIndex === 0}
                    >
                      <SkipPreviousIcon />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title={playing ? 'Pause' : 'Play'}>
                    <IconButton
                      onClick={() => setPlaying(!playing)}
                      sx={{
                        bgcolor: 'primary.main',
                        color: '#000',
                        '&:hover': { bgcolor: 'primary.dark' },
                        width: { xs: 36, sm: 44 },
                        height: { xs: 36, sm: 44 },
                      }}
                    >
                      {playing ? <PauseIcon /> : <PlayArrowIcon />}
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Next step">
                    <IconButton
                      size="small"
                      onClick={() => setCurrentIndex(Math.min(states.length - 1, currentIndex + 1))}
                      disabled={currentIndex === states.length - 1}
                    >
                      <SkipNextIcon />
                    </IconButton>
                  </Tooltip>
                </Box>
                <Box sx={{ flexGrow: 1, mx: { xs: 1, sm: 2 }, minWidth: 80 }}>
                  <Slider
                    value={currentIndex}
                    min={0}
                    max={states.length - 1}
                    step={1}
                    onChange={(_, v) => {
                      setPlaying(false);
                      setCurrentIndex(v as number);
                    }}
                    sx={{
                      '& .MuiSlider-track': { bgcolor: cfg.color },
                      '& .MuiSlider-thumb': { bgcolor: cfg.color },
                    }}
                  />
                </Box>
                {/* Click to cycle through speeds — easier hit target than
                    reaching back to the Speed dropdown in the Controls Card,
                    which the reviewer's first instinct was to click anyway. */}
                <Tooltip title="Click to cycle playback speed">
                  <Chip
                    icon={<SpeedIcon />}
                    label={`${speed}x`}
                    size="small"
                    variant="outlined"
                    clickable
                    onClick={() => {
                      const order = [0.5, 1, 2, 4];
                      const i = order.indexOf(speed);
                      setSpeed(order[(i + 1) % order.length]);
                    }}
                    sx={{
                      fontWeight: 600,
                      '&:focus-visible': { outline: '2px solid currentColor', outlineOffset: 2 },
                    }}
                  />
                </Tooltip>
              </Box>

              {/* State transition timeline bar — segments are weighted by
                  the time the state lasted, so a 30s blip and a 25-min STOP
                  no longer look identical. The last segment runs to "now"
                  (or the most recent evaluation). */}
              <Box
                sx={{
                  display: 'flex',
                  height: 28,
                  borderRadius: 1,
                  overflow: 'hidden',
                  border: '1px solid rgba(255,255,255,0.1)',
                }}
              >
                {(() => {
                  const startTimes = states.map((s) => new Date(s.evaluated_at).getTime());
                  const endTimes = startTimes.map((t, i) =>
                    i + 1 < startTimes.length ? startTimes[i + 1] : t + 60_000,
                  );
                  const totalSpan = Math.max(1, endTimes[endTimes.length - 1] - startTimes[0]);
                  return states.map((s, i) => {
                    const sCfg = STATE_CONFIG[stateOf(s.state)];
                    const isActive = i === currentIndex;
                    const span = endTimes[i] - startTimes[i];
                    // Floor at 1% so a single-evaluation blip is still clickable
                    const flexWeight = Math.max(0.01, span / totalSpan);
                    return (
                      <Tooltip
                        key={i}
                        title={
                          transitionHasAlert.has(s.id)
                            ? `${sCfg.label} — ${formatSAST(s.evaluated_at)} (alert sent)`
                            : `${sCfg.label} — ${formatSAST(s.evaluated_at)}`
                        }
                      >
                        <Box
                          onClick={() => {
                            setPlaying(false);
                            setCurrentIndex(i);
                          }}
                          sx={{
                            flex: flexWeight,
                            bgcolor: sCfg.color,
                            opacity: i <= currentIndex ? 1 : 0.25,
                            cursor: 'pointer',
                            transition: 'opacity 0.2s',
                            borderRight: '1px solid rgba(0,0,0,0.3)',
                            position: 'relative',
                            '&:hover': { opacity: 0.8 },
                            ...(isActive && {
                              boxShadow: `0 0 0 2px #fff`,
                              zIndex: 1,
                            }),
                          }}
                        >
                          {transitionHasAlert.has(s.id) && (
                            <Box
                              sx={{
                                position: 'absolute',
                                top: -14,
                                left: '50%',
                                transform: 'translateX(-50%)',
                                pointerEvents: 'none',
                              }}
                            >
                              {/* Bell color matches the legend swatch (#fbc02d), not the
                                  segment state. The segment's background already carries
                                  state colour; making the bell state-coloured would mismatch
                                  the legend and confuse the "Alert sent" affordance. */}
                              <NotificationsIcon sx={{ fontSize: 14, color: '#fbc02d' }} />
                            </Box>
                          )}
                        </Box>
                      </Tooltip>
                    );
                  });
                })()}
              </Box>
            </CardContent>
          </Card>

          {/* Legend — explains what map dots mean and the alert-attribution boundary */}
          <Card sx={{ mb: 1.5 }}>
            <CardContent sx={{ py: 1, px: 2, '&:last-child': { pb: 1 } }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: '#f44336' }} />
                  <Typography variant="caption">STOP zone</Typography>
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: '#fbc02d' }} />
                  <Typography variant="caption">PREPARE zone</Typography>
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <Box
                    sx={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      bgcolor: '#90a4ae',
                      opacity: 0.6,
                    }}
                  />
                  <Typography variant="caption">Outside alert radius (context only)</Typography>
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <NotificationsIcon sx={{ fontSize: 14, color: '#fbc02d' }} />
                  <Typography variant="caption">Alert sent</Typography>
                </Box>
                <Box sx={{ flexGrow: 1 }} />
                <Button
                  size="small"
                  variant={showWiderView ? 'contained' : 'outlined'}
                  onClick={() => setShowWiderView((v) => !v)}
                >
                  {showWiderView ? 'Focus on alert area' : 'Show wider view'}
                </Button>
              </Box>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block', mt: 0.5 }}
              >
                Alerts can be triggered by strikes inside your alert radius (subject to threshold
                counts). Strikes outside are shown for context and did not trigger an alert.
              </Typography>
              {flashesTruncated && (
                <Typography
                  variant="caption"
                  color="warning.main"
                  sx={{ display: 'block', mt: 0.5 }}
                >
                  Showing the first 5000 flashes in this window. Narrow the lookback to see all
                  data.
                </Typography>
              )}
            </CardContent>
          </Card>

          {/* Map + flash table side by side */}
          <Grid container spacing={2}>
            <Grid item xs={12} md={7}>
              <Card sx={{ overflow: 'hidden' }}>
                <Box sx={{ position: 'relative', height: { xs: 280, sm: 350, md: 400 } }}>
                  <MapBase basemap="dark" center={center} zoom={10}>
                    {loc && (
                      <>
                        <FitToRadius
                          lat={loc.lat}
                          lng={loc.lng}
                          radiusKm={showWiderView ? 200 : prepareRadiusKm}
                          version={selectedLocation.length + (showWiderView ? 1 : 0)}
                        />
                        <Circle
                          center={center}
                          radius={prepareRadiusKm * 1000}
                          pathOptions={{
                            color: '#fbc02d',
                            weight: 1,
                            opacity: 0.3,
                            fillOpacity: 0.05,
                          }}
                        />
                        <Circle
                          center={center}
                          radius={stopRadiusKm * 1000}
                          pathOptions={{
                            color: '#d32f2f',
                            weight: 1,
                            opacity: 0.4,
                            fillOpacity: 0.08,
                          }}
                        />
                        <CircleMarker
                          center={center}
                          radius={10}
                          pane="markerPane"
                          pathOptions={{
                            color: cfg.color,
                            fillColor: cfg.color,
                            fillOpacity: 0.9,
                            weight: 3,
                          }}
                        >
                          <Popup>
                            <strong>{loc.name}</strong>
                            <br />
                            State: {cfg.label}
                          </Popup>
                        </CircleMarker>
                      </>
                    )}
                    {lightningSource === 'afa' ? (
                      <CellsByIncidenceLayer pixels={visibleAfaPixels} />
                    ) : (
                      flashesWithZone.map((f, idx) => {
                        const age = (currentTime - new Date(f.flash_time_utc).getTime()) / 60000;
                        const opacityDecay = Math.max(
                          0.4,
                          1 - age / (replayLoc?.stop_window_min ?? 15),
                        );
                        const isOutside = f.zone === 'OUTSIDE';
                        const fillColor =
                          f.zone === 'STOP'
                            ? '#f44336'
                            : f.zone === 'PREPARE'
                              ? '#fbc02d'
                              : '#90a4ae';
                        const radius = isOutside ? 3 : 5;
                        const finalOpacity = isOutside ? 0.4 : opacityDecay;
                        return (
                          <CircleMarker
                            key={`${f.flash_id}-${idx}`}
                            center={[f.latitude, f.longitude]}
                            radius={radius}
                            pathOptions={{
                              color: fillColor,
                              fillColor,
                              fillOpacity: finalOpacity,
                              weight: isOutside ? 1 : 1.5,
                              opacity: finalOpacity,
                            }}
                          >
                            <Popup>
                              ⚡ Flash #{f.flash_id}
                              <br />
                              {formatSAST(f.flash_time_utc)} SAST
                              <br />
                              Zone: <strong>{f.zone}</strong>
                              {isOutside && (
                                <>
                                  <br />
                                  <em>
                                    Outside alert radius — not counted toward STOP / PREPARE
                                    thresholds.
                                  </em>
                                </>
                              )}
                              <br />
                              Distance: {f.distance_km.toFixed(1)} km
                            </Popup>
                          </CircleMarker>
                        );
                      })
                    )}
                  </MapBase>
                </Box>
              </Card>
            </Grid>

            <Grid item xs={12} md={5}>
              <Card sx={{ height: { xs: 300, md: 400 }, display: 'flex', flexDirection: 'column' }}>
                <CardContent
                  sx={{ py: 1.5, px: 2, borderBottom: '1px solid rgba(255,255,255,0.08)' }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <FlashOnIcon sx={{ fontSize: 18, color: '#fbc02d' }} />
                    <Typography variant="subtitle2">
                      {lightningSource === 'afa'
                        ? `AFA pixels in evaluation window (${visibleAfaPixels.length})`
                        : `Flashes in evaluation window (${flashesWithZone.length})`}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ ml: 'auto', fontSize: 10 }}
                    >
                      last {replayLoc?.stop_window_min ?? 15} min
                    </Typography>
                  </Box>
                </CardContent>
                <TableContainer sx={{ flexGrow: 1 }}>
                  <Table size="small" stickyHeader>
                    {lightningSource === 'afa' ? (
                      <>
                        <TableHead>
                          <TableRow>
                            <TableCell sx={{ fontSize: 11, py: 0.5 }}>Time (SAST)</TableCell>
                            <TableCell sx={{ fontSize: 11, py: 0.5 }}>Lat</TableCell>
                            <TableCell sx={{ fontSize: 11, py: 0.5 }}>Lon</TableCell>
                            <TableCell sx={{ fontSize: 11, py: 0.5 }}>Flash count</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {visibleAfaPixels.slice(0, 50).map((p, i) => (
                            <TableRow key={i} hover>
                              <TableCell sx={{ fontSize: 12, py: 0.5, fontFamily: 'monospace' }}>
                                {formatSAST(p.observed_at_utc)}
                              </TableCell>
                              <TableCell sx={{ fontSize: 12, py: 0.5 }}>
                                {p.pixel_lat.toFixed(3)}
                              </TableCell>
                              <TableCell sx={{ fontSize: 12, py: 0.5 }}>
                                {p.pixel_lon.toFixed(3)}
                              </TableCell>
                              <TableCell sx={{ fontSize: 12, py: 0.5 }}>{p.flash_count}</TableCell>
                            </TableRow>
                          ))}
                          {visibleAfaPixels.length === 0 && (
                            <TableRow>
                              <TableCell
                                colSpan={4}
                                align="center"
                                sx={{ py: 4, color: 'text.secondary', fontSize: 12 }}
                              >
                                No AFA pixels in the {replayLoc?.stop_window_min ?? 15}-min
                                evaluation window at this time
                              </TableCell>
                            </TableRow>
                          )}
                          {visibleAfaPixels.length > 50 && (
                            <TableRow>
                              <TableCell
                                colSpan={4}
                                align="center"
                                sx={{ py: 1, color: 'text.secondary', fontSize: 11, fontStyle: 'italic' }}
                              >
                                +{visibleAfaPixels.length - 50} more pixels — showing first 50 of{' '}
                                {visibleAfaPixels.length}
                              </TableCell>
                            </TableRow>
                          )}
                        </TableBody>
                      </>
                    ) : (
                      <>
                        <TableHead>
                          <TableRow>
                            <TableCell sx={{ fontSize: 11, py: 0.5 }}>Time (SAST)</TableCell>
                            <TableCell sx={{ fontSize: 11, py: 0.5 }}>
                              <Box sx={{ display: 'inline-flex', alignItems: 'center' }}>
                                Zone
                                <InfoTip
                                  inline
                                  title={helpTitle('replay_zone')}
                                  body={helpBody('replay_zone')}
                                />
                              </Box>
                            </TableCell>
                            <TableCell sx={{ fontSize: 11, py: 0.5 }}>Dist (km)</TableCell>
                            <TableCell sx={{ fontSize: 11, py: 0.5 }}>
                              <Box sx={{ display: 'inline-flex', alignItems: 'center' }}>
                                Radiance
                                <InfoTip
                                  inline
                                  title={helpTitle('replay_radiance')}
                                  body={helpBody('replay_radiance')}
                                />
                              </Box>
                            </TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {flashesWithZone.slice(0, 50).map((f, i) => {
                            const zoneColor =
                              f.zone === 'STOP'
                                ? '#f44336'
                                : f.zone === 'PREPARE'
                                  ? '#fbc02d'
                                  : '#90a4ae';
                            const zoneBg =
                              f.zone === 'STOP'
                                ? 'rgba(211,47,47,0.15)'
                                : f.zone === 'PREPARE'
                                  ? 'rgba(251,192,45,0.15)'
                                  : 'rgba(144,164,174,0.12)';
                            return (
                              <TableRow key={i} hover sx={{ borderLeft: `3px solid ${zoneColor}` }}>
                                <TableCell sx={{ fontSize: 12, py: 0.5, fontFamily: 'monospace' }}>
                                  {formatSAST(f.flash_time_utc)}
                                </TableCell>
                                <TableCell sx={{ fontSize: 11, py: 0.5 }}>
                                  <Chip
                                    label={f.zone}
                                    size="small"
                                    sx={{
                                      height: 18,
                                      fontSize: 10,
                                      fontWeight: 700,
                                      bgcolor: zoneBg,
                                      color: zoneColor,
                                      border: `1px solid ${zoneColor}`,
                                    }}
                                  />
                                </TableCell>
                                <TableCell sx={{ fontSize: 12, py: 0.5 }}>
                                  {f.distance_km.toFixed(1)}
                                </TableCell>
                                <TableCell sx={{ fontSize: 12, py: 0.5 }}>
                                  {f.radiance != null ? f.radiance.toFixed(1) : '—'}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                          {flashesWithZone.length === 0 && (
                            <TableRow>
                              <TableCell
                                colSpan={4}
                                align="center"
                                sx={{ py: 4, color: 'text.secondary', fontSize: 12 }}
                              >
                                No flashes in the {replayLoc?.stop_window_min ?? 15}-min evaluation
                                window at this time
                              </TableCell>
                            </TableRow>
                          )}
                          {flashesWithZone.length > 50 && (
                            <TableRow>
                              <TableCell
                                colSpan={4}
                                align="center"
                                sx={{
                                  py: 1,
                                  color: 'text.secondary',
                                  fontSize: 11,
                                  fontStyle: 'italic',
                                }}
                              >
                                +{flashesWithZone.length - 50} more flashes — showing first 50 of{' '}
                                {flashesWithZone.length}
                              </TableCell>
                            </TableRow>
                          )}
                        </TableBody>
                      </>
                    )}
                  </Table>
                </TableContainer>
              </Card>
            </Grid>
          </Grid>

          {/* State history table */}
          <Card sx={{ mt: 2 }}>
            <CardContent sx={{ py: 1.5, px: 2, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <Typography variant="subtitle2">
                <TimelineIcon sx={{ fontSize: 16, mr: 0.5, verticalAlign: 'text-bottom' }} />
                State Transition Log ({states.length} evaluations)
              </Typography>
            </CardContent>
            <TableContainer sx={{ maxHeight: 300, overflowX: 'auto' }}>
              <Table size="small" stickyHeader sx={{ minWidth: 500 }}>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontSize: 11 }}>#</TableCell>
                    <TableCell sx={{ fontSize: 11 }}>Time (SAST)</TableCell>
                    <TableCell sx={{ fontSize: 11 }}>State</TableCell>
                    <TableCell sx={{ fontSize: 11 }}>Previous</TableCell>
                    <TableCell sx={{ fontSize: 11 }}>STOP Flashes</TableCell>
                    <TableCell sx={{ fontSize: 11 }}>Nearest (km)</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {states.map((s, i) => {
                    const sCfg = STATE_CONFIG[stateOf(s.state)];
                    const isActive = i === currentIndex;
                    return (
                      <TableRow
                        key={i}
                        hover
                        selected={isActive}
                        onClick={() => {
                          setPlaying(false);
                          setCurrentIndex(i);
                        }}
                        sx={{
                          cursor: 'pointer',
                          ...(isActive && { bgcolor: `${sCfg.color}20 !important` }),
                        }}
                      >
                        <TableCell sx={{ fontSize: 12 }}>{i + 1}</TableCell>
                        <TableCell sx={{ fontSize: 12, fontFamily: 'monospace' }}>
                          {formatSAST(s.evaluated_at)}
                        </TableCell>
                        <TableCell>
                          <Chip
                            label={sCfg.label}
                            size="small"
                            sx={{
                              height: 20,
                              fontSize: 10,
                              fontWeight: 700,
                              bgcolor: sCfg.color,
                              color: '#fff',
                            }}
                          />
                        </TableCell>
                        <TableCell sx={{ fontSize: 12 }}>{s.previous_state || '—'}</TableCell>
                        <TableCell sx={{ fontSize: 12 }}>{s.flashes_in_stop_radius}</TableCell>
                        <TableCell sx={{ fontSize: 12 }}>
                          {s.nearest_flash_km != null ? s.nearest_flash_km.toFixed(1) : '—'}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          </Card>
        </>
      )}
    </Box>
  );
}

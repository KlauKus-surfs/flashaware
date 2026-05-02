import React from 'react';
import { Box, Button, Card, Divider, Typography } from '@mui/material';
import { CircleMarker, Circle, Popup } from 'react-leaflet';
import { DateTime } from 'luxon';
import type { LatLngExpression } from 'leaflet';
import { MapBase } from '../components/MapBase';
import InfoTip from '../components/InfoTip';
import { helpBody, helpTitle } from '../help/copy';
import { formatSAST, timeAgo } from '../utils/format';
import { STATE_CONFIG, stateOf } from '../states';
import { FitAllBounds } from './FitAllBounds';
import type { Flash, LocationStatus } from './types';

const SA_CENTER: LatLngExpression = [-28.5, 25.5];
const SA_ZOOM = 6;

// The flash-activity map block from the dashboard. Owns its own legend +
// counter overlays + EUMETSAT attribution. Imperative "fit all" lives in
// the parent (Dashboard) so it can also be triggered by header actions;
// this component just renders, plus calls onFitRequested when its own
// "Fit all" button is clicked.
export function DashboardMap({
  visibleLocations,
  flashes,
  stopsCount,
  fitVersion,
  onFitRequested,
  isMobile,
}: {
  visibleLocations: LocationStatus[];
  flashes: Flash[];
  stopsCount: number;
  fitVersion: number;
  onFitRequested: () => void;
  isMobile: boolean;
}) {
  return (
    <Card sx={{ overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)' }}>
      <Box sx={{ height: { xs: 320, sm: 420, md: 520 }, position: 'relative' }}>
        {/* Flash counter overlay */}
        <Box
          sx={{
            position: 'absolute',
            top: 8,
            right: 8,
            zIndex: 1000,
            bgcolor: 'rgba(10,25,41,0.85)',
            backdropFilter: 'blur(8px)',
            borderRadius: 2,
            px: { xs: 1.5, sm: 2 },
            py: { xs: 0.5, sm: 1 },
            display: 'flex',
            gap: { xs: 1.5, sm: 2 },
            border: '1px solid rgba(255,255,255,0.1)',
          }}
        >
          <Box sx={{ textAlign: 'center' }}>
            <Typography sx={{ fontSize: 18, fontWeight: 700, color: '#ff9800' }}>
              {flashes.length}
            </Typography>
            <Typography
              sx={{
                fontSize: 9,
                color: 'text.secondary',
                textTransform: 'uppercase',
                letterSpacing: 0.5,
              }}
            >
              Flashes
            </Typography>
          </Box>
          <Divider orientation="vertical" flexItem />
          <Box sx={{ textAlign: 'center' }}>
            <Typography
              sx={{
                fontSize: 18,
                fontWeight: 700,
                color: stopsCount > 0 ? '#d32f2f' : '#66bb6a',
              }}
            >
              {stopsCount}
            </Typography>
            <Typography
              sx={{
                fontSize: 9,
                color: 'text.secondary',
                textTransform: 'uppercase',
                letterSpacing: 0.5,
              }}
            >
              Alerts
            </Typography>
          </Box>
        </Box>

        <Box sx={{ position: 'absolute', bottom: 16, right: 16, zIndex: 1000 }}>
          <Button
            size="small"
            variant="contained"
            color="inherit"
            onClick={onFitRequested}
            sx={{
              bgcolor: 'rgba(10,25,41,0.85)',
              color: '#fff',
              fontSize: 11,
              backdropFilter: 'blur(8px)',
              border: '1px solid rgba(255,255,255,0.1)',
              '&:hover': { bgcolor: 'rgba(10,25,41,0.95)' },
            }}
            aria-label="Fit map to all locations"
          >
            Fit all
          </Button>
        </Box>

        {/* Legend overlay — explains the rings + flash colors so first-time
            viewers don't have to guess. Desktop shows the inline legend +
            an info button for the *why*. Mobile collapses the whole legend
            into a single floating info button so the map keeps its real
            estate. */}
        <Box
          sx={{
            position: 'absolute',
            bottom: 8,
            left: 8,
            zIndex: 1000,
            bgcolor: 'rgba(10,25,41,0.85)',
            backdropFilter: 'blur(8px)',
            borderRadius: 2,
            px: 1.5,
            py: 1,
            fontSize: 11,
            border: '1px solid rgba(255,255,255,0.1)',
            display: { xs: 'none', sm: 'block' },
            maxWidth: 240,
          }}
        >
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              mb: 0.5,
            }}
          >
            <Typography
              sx={{
                fontSize: 10,
                color: 'text.secondary',
                textTransform: 'uppercase',
                letterSpacing: 0.5,
              }}
            >
              Legend
            </Typography>
            <InfoTip inline title={helpTitle('map_legend')} body={helpBody('map_legend')} />
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.4 }}>
            <Box
              sx={{
                width: 12,
                height: 12,
                borderRadius: '50%',
                border: '2px solid #d32f2f',
                bgcolor: 'rgba(211,47,47,0.15)',
              }}
            />
            <Typography sx={{ fontSize: 11 }}>STOP radius</Typography>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.4 }}>
            <Box
              sx={{
                width: 12,
                height: 12,
                borderRadius: '50%',
                border: '2px dashed #fbc02d',
                bgcolor: 'rgba(251,192,45,0.05)',
              }}
            />
            <Typography sx={{ fontSize: 11 }}>PREPARE radius</Typography>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.4 }}>
            <Box
              sx={{
                width: 12,
                height: 12,
                borderRadius: '50%',
                bgcolor: '#ff5722',
                border: '2px solid #fff',
              }}
            />
            <Typography sx={{ fontSize: 11 }}>Flash &lt; 5 min old</Typography>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
            <Box sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: '#ff9800' }} />
            <Typography sx={{ fontSize: 11 }}>Flash up to 30 min</Typography>
          </Box>
        </Box>
        {/* Mobile-only floating info button — opens a dialog containing the
            same legend content, since the inline legend above is hidden at
            xs to save space. */}
        <Box
          sx={{
            position: 'absolute',
            bottom: 8,
            left: 8,
            zIndex: 1000,
            display: { xs: 'block', sm: 'none' },
            bgcolor: 'rgba(10,25,41,0.85)',
            backdropFilter: 'blur(8px)',
            borderRadius: '50%',
            border: '1px solid rgba(255,255,255,0.15)',
          }}
        >
          <InfoTip
            variant="dialog"
            title="Map legend"
            ariaLabel="Open map legend"
            body={
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <Typography variant="body2">{helpBody('map_legend')}</Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Box
                    sx={{
                      width: 14,
                      height: 14,
                      borderRadius: '50%',
                      border: '2px solid #d32f2f',
                      bgcolor: 'rgba(211,47,47,0.15)',
                    }}
                  />
                  <Typography variant="body2">STOP radius</Typography>
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Box
                    sx={{
                      width: 14,
                      height: 14,
                      borderRadius: '50%',
                      border: '2px dashed #fbc02d',
                      bgcolor: 'rgba(251,192,45,0.05)',
                    }}
                  />
                  <Typography variant="body2">PREPARE radius</Typography>
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Box
                    sx={{
                      width: 14,
                      height: 14,
                      borderRadius: '50%',
                      bgcolor: '#ff5722',
                      border: '2px solid #fff',
                    }}
                  />
                  <Typography variant="body2">Flash &lt; 5 min old</Typography>
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Box sx={{ width: 14, height: 14, borderRadius: '50%', bgcolor: '#ff9800' }} />
                  <Typography variant="body2">Flash up to 30 min</Typography>
                </Box>
              </Box>
            }
          />
        </Box>

        <MapBase basemap="dark" center={SA_CENTER} zoom={SA_ZOOM} scrollWheelZoom={!isMobile}>
          <FitAllBounds locations={visibleLocations} version={fitVersion} />

          {/* Location markers with buffer rings */}
          {visibleLocations.map((loc) => {
            const cfg = STATE_CONFIG[stateOf(loc.state)];
            const pos: LatLngExpression = [loc.lat, loc.lng];
            return (
              <React.Fragment key={loc.id}>
                <Circle
                  center={pos}
                  radius={(loc.prepare_radius_km || 20) * 1000}
                  pathOptions={{
                    color: '#fbc02d',
                    weight: 1,
                    opacity: 0.25,
                    fillOpacity: 0.04,
                    dashArray: '5 5',
                  }}
                />
                <Circle
                  center={pos}
                  radius={(loc.stop_radius_km || 10) * 1000}
                  pathOptions={{ color: '#d32f2f', weight: 1.5, opacity: 0.4, fillOpacity: 0.06 }}
                />
                {/* Marker is in the markerPane (z-index 600) so it stays
                    visually distinct from the radius rings (overlayPane,
                    z-index 400) at any zoom — including extreme zoom-in
                    where rings would otherwise fill the viewport and hide
                    the centroid dot entirely. */}
                <CircleMarker
                  center={pos}
                  radius={9}
                  pane="markerPane"
                  pathOptions={{ color: '#fff', fillColor: cfg.color, fillOpacity: 1, weight: 2 }}
                >
                  <Popup>
                    <div style={{ minWidth: 160 }}>
                      <strong style={{ fontSize: 14 }}>{loc.name}</strong>
                      <br />
                      <span style={{ color: cfg.color, fontWeight: 700 }}>
                        {cfg.emoji} {cfg.label}
                      </span>
                      <br />
                      {loc.nearest_flash_km !== null && (
                        <span>
                          Nearest flash: <strong>{loc.nearest_flash_km.toFixed(1)} km</strong>
                          <br />
                        </span>
                      )}
                      {loc.flashes_in_stop_radius !== null && (
                        <span>
                          In STOP zone: <strong>{loc.flashes_in_stop_radius}</strong>
                          <br />
                        </span>
                      )}
                      {loc.evaluated_at && (
                        <span style={{ fontSize: 11, color: '#999' }}>
                          Updated: {formatSAST(loc.evaluated_at)} SAST
                        </span>
                      )}
                    </div>
                  </Popup>
                </CircleMarker>
              </React.Fragment>
            );
          })}

          {/* Flash events */}
          {flashes.map((f, idx) => {
            const age = DateTime.utc().diff(
              DateTime.fromISO(f.flash_time_utc, { zone: 'utc' }),
              'minutes',
            ).minutes;
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
                    <strong>Flash #{f.flash_id}</strong>
                    <br />
                    <span style={{ fontSize: 12 }}>{formatSAST(f.flash_time_utc)} SAST</span>
                    <br />
                    <span style={{ fontSize: 12 }}>{timeAgo(f.flash_time_utc)}</span>
                    <br />
                    {f.radiance != null && (
                      <span style={{ fontSize: 12 }}>
                        Radiance: {f.radiance.toFixed(2)}
                        <br />
                      </span>
                    )}
                    {f.duration_ms != null && (
                      <span style={{ fontSize: 12 }}>Duration: {f.duration_ms} ms</span>
                    )}
                  </div>
                </Popup>
              </CircleMarker>
            );
          })}
        </MapBase>
      </Box>
      {/* Required EUMETSAT attribution per their data licence template:
          "[Contains modified] EUMETSAT [Meteosat/Metop] [data/product]
          [Year]". The Lightning Imager flies on MTG (Meteosat Third
          Generation), not on Metop (Metop is polar-orbiting and carries
          different instruments). The previous wording said "Metop LI" —
          wrong satellite series. */}
      <Box sx={{ px: 2, py: 1, bgcolor: 'rgba(255,255,255,0.02)' }}>
        <Typography
          variant="body2"
          color="text.secondary"
          align="right"
          sx={{ fontSize: 10, lineHeight: 1.2 }}
        >
          Contains in part modified EUMETSAT Meteosat MTG-LI L2 data {new Date().getUTCFullYear()}{' '}
          <Box
            component="a"
            href="https://user.eumetsat.int/data/satellites/meteosat-third-generation"
            target="_blank"
            rel="noopener noreferrer"
            sx={{
              color: 'text.secondary',
              textDecoration: 'underline',
              '&:hover': { color: 'primary.main' },
            }}
            aria-label="EUMETSAT Meteosat Third Generation data licence and source"
          >
            (source)
          </Box>
        </Typography>
      </Box>
    </Card>
  );
}

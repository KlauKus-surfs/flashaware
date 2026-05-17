import React from 'react';
import { Box, Card, CardContent, Chip, Tooltip, Typography } from '@mui/material';
import FlashOnIcon from '@mui/icons-material/FlashOn';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import RadarIcon from '@mui/icons-material/Radar';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { useNavigate } from 'react-router-dom';
import { formatSAST, timeAgo, displayZoneLabel } from '../utils/format';
import { STATE_CONFIG, stateOf } from '../states';
import type { LocationStatus } from './types';

// Status card for a single monitored location. Cards drill into Replay
// scoped to this location — that's where operators get the recent flash
// table, state-transition timeline, and map zoomed to the site. Replay
// reads the `locationId` query param on mount.
export function StatusCard({ loc, pulse }: { loc: LocationStatus; pulse?: boolean }) {
  const navigate = useNavigate();
  // If the server tells us is_degraded=true, render as DEGRADED no matter what
  // `state` says. The server can briefly report (state=ALL_CLEAR, is_degraded=
  // true) during recovery; the operator's mental model "this site is safe to
  // resume" requires we always show the more conservative read. Mirrors the
  // dashboard count derivation in Dashboard.tsx.
  const effectiveState = loc.is_degraded ? 'DEGRADED' : loc.state;
  const cfg = STATE_CONFIG[stateOf(effectiveState)];
  const reasonText = typeof loc.reason === 'object' ? loc.reason?.reason : loc.reason;
  const isUrgent = effectiveState === 'STOP' || effectiveState === 'HOLD';

  const handleCardClick = (e: React.MouseEvent) => {
    // Don't navigate when the click landed on an inner button (e.g. the NO
    // RECIPIENTS chip's own onClick). e.defaultPrevented is set by the
    // child handler.
    if (e.defaultPrevented) return;
    navigate(`/replay?locationId=${encodeURIComponent(loc.id)}`);
  };
  const handleCardKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      navigate(`/replay?locationId=${encodeURIComponent(loc.id)}`);
    }
  };

  // Single animation policy: pulse fires once on state-change to draw the eye,
  // then the steady urgentGlow takes over for as long as the site is unsafe.
  // We do NOT also pulse the inner state badge — stacking three concurrent
  // infinite animations on the dashboard was too busy.
  return (
    <Card
      onClick={handleCardClick}
      onKeyDown={handleCardKey}
      role="button"
      tabIndex={0}
      aria-label={`Open ${loc.name} in Replay`}
      sx={{
        border: `1px solid ${cfg.color}55`,
        bgcolor: cfg.bg,
        transition: 'all 0.3s ease',
        position: 'relative',
        overflow: 'hidden',
        cursor: 'pointer',
        '&:focus-visible': { outline: `2px solid ${cfg.color}`, outlineOffset: 2 },
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
      }}
    >
      {/* Top accent bar */}
      <Box sx={{ height: 3, bgcolor: cfg.color, borderRadius: '12px 12px 0 0' }} />
      <CardContent sx={{ pt: 1.5, '&:last-child': { pb: 1.5 } }}>
        {/* Header: type tag + state badge share row 1, name gets its own row.
            Single-row layout with flex:1 collapses the name to 0 at 4-col widths
            because the badge has flexShrink:0 + nowrap. */}
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            mb: 0.3,
            gap: 1,
          }}
        >
          <Typography
            variant="subtitle2"
            color="text.secondary"
            noWrap
            sx={{
              textTransform: 'uppercase',
              fontSize: 10,
              letterSpacing: 1.2,
              minWidth: 0,
              flex: 1,
            }}
          >
            {loc.site_type?.replace('_', ' ')}
          </Typography>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              bgcolor: cfg.color,
              color: cfg.textColor,
              px: 1,
              py: 0.4,
              borderRadius: 2,
              fontWeight: 700,
              fontSize: 10,
              letterSpacing: 0.5,
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            <span style={{ fontSize: 10 }}>{cfg.emoji}</span> {cfg.label}
          </Box>
        </Box>
        <Typography
          variant="h6"
          sx={{ fontSize: 15, fontWeight: 600, lineHeight: 1.2, mb: 1.5 }}
          noWrap
        >
          {loc.name}
          {loc.is_demo && (
            <Chip
              label="DEMO"
              size="small"
              sx={{
                ml: 1,
                height: 16,
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: 0.5,
                // theme.action.hover swaps with mode (~8% white on dark,
                // ~4% black on light). Previously hard-coded white@12%
                // disappeared on light mode cards.
                bgcolor: (t) => t.palette.action.selected,
                color: 'text.secondary',
                verticalAlign: 'middle',
              }}
            />
          )}
        </Typography>
        {/* Armed location with zero recipients = STOP fires nothing. Surface
            this as a soft warning AND give it a one-click fix: clicking the
            chip deep-links to the editor with the recipients tab in scope.
            stopPropagation prevents the card-level click from also firing
            (which would navigate to Replay instead). */}
        {loc.active_recipient_count === 0 && (
          <Tooltip title="No active recipients. Click to add one — STOP / PREPARE alerts are currently logged but not delivered.">
            <Box
              role="button"
              tabIndex={0}
              aria-label={`Add a recipient for ${loc.name}`}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                navigate(`/locations?edit=${encodeURIComponent(loc.id)}`);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  navigate(`/locations?edit=${encodeURIComponent(loc.id)}`);
                }
              }}
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.5,
                // Light-mode bug fix: #ffb74d (pale orange) on
                // rgba(237,108,2,0.18) was effectively invisible on a
                // white card. Switch both bg-tint and text-tint based on
                // the theme so the warning reads in both modes — dark
                // mode keeps its airier feel; light mode gets a darker
                // amber (~#b25400) on a slightly stronger orange wash
                // that hits WCAG AA contrast against light backgrounds.
                bgcolor: (t) =>
                  t.palette.mode === 'light'
                    ? 'rgba(237,108,2,0.14)'
                    : 'rgba(237,108,2,0.18)',
                color: (t) => (t.palette.mode === 'light' ? '#b25400' : '#ffb74d'),
                px: 0.75,
                py: 0.25,
                borderRadius: 1,
                fontSize: 10,
                fontWeight: 600,
                border: (t) =>
                  `1px solid ${
                    t.palette.mode === 'light'
                      ? 'rgba(237,108,2,0.45)'
                      : 'rgba(237,108,2,0.35)'
                  }`,
                mb: 1,
                cursor: 'pointer',
                transition: 'background-color 0.15s, border-color 0.15s',
                '&:hover': {
                  bgcolor: (t) =>
                    t.palette.mode === 'light'
                      ? 'rgba(237,108,2,0.22)'
                      : 'rgba(237,108,2,0.28)',
                  borderColor: 'rgba(237,108,2,0.6)',
                },
                '&:focus-visible': {
                  outline: (t) =>
                    `2px solid ${t.palette.mode === 'light' ? '#b25400' : '#ffb74d'}`,
                  outlineOffset: 2,
                },
              }}
            >
              <WarningAmberIcon sx={{ fontSize: 12 }} />
              <span>NO RECIPIENTS — ADD →</span>
            </Box>
          </Tooltip>
        )}

        {/* Metrics row */}
        <Box
          sx={{
            display: 'flex',
            gap: 0.5,
            flexWrap: 'wrap',
            p: 1,
            borderRadius: 1.5,
            // rgba(0,0,0,0.15) muddied light-mode tints on top of the
            // already-coloured cfg.bg card. action.hover gives a much
            // subtler wash that picks the right direction per theme.
            bgcolor: (t) => t.palette.action.hover,
          }}
        >
          {loc.nearest_flash_km !== null && (
            <Tooltip title="Nearest flash distance" arrow>
              <Chip
                icon={<FlashOnIcon sx={{ fontSize: '14px !important' }} />}
                label={`${loc.nearest_flash_km.toFixed(1)} km`}
                size="small"
                sx={{
                  height: 24,
                  fontSize: 11,
                  fontWeight: 600,
                  bgcolor: (t) =>
                    loc.nearest_flash_km !== null && loc.nearest_flash_km < 10
                      ? 'rgba(211,47,47,0.25)'
                      : t.palette.action.selected,
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
                sx={{
                  height: 24,
                  fontSize: 11,
                  // Theme-aware: action.selected is ~16% black on light
                  // and ~16% white on dark. Replaces a hard-coded
                  // white@8% that was invisible on the white card surface
                  // in light mode.
                  bgcolor: (t) => t.palette.action.selected,
                  '& .MuiChip-icon': { color: '#ef5350' },
                }}
              />
            </Tooltip>
          )}
          {loc.evaluated_at && (
            <Tooltip
              title={`Evaluated: ${formatSAST(loc.evaluated_at)} ${displayZoneLabel(loc.evaluated_at)}`}
              arrow
            >
              <Chip
                icon={<AccessTimeIcon sx={{ fontSize: '14px !important' }} />}
                label={timeAgo(loc.evaluated_at)}
                size="small"
                sx={{
                  height: 24,
                  fontSize: 11,
                  // Theme-aware: action.selected is ~16% black on light
                  // and ~16% white on dark. Replaces a hard-coded
                  // white@8% that was invisible on the white card surface
                  // in light mode.
                  bgcolor: (t) => t.palette.action.selected,
                  '& .MuiChip-icon': { color: 'text.secondary' },
                }}
              />
            </Tooltip>
          )}
        </Box>

        {reasonText && (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{
              mt: 1.5,
              fontSize: 11,
              lineHeight: 1.6,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {reasonText}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

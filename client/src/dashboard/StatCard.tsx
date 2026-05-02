import React from 'react';
import { Box, Paper, Typography } from '@mui/material';

// Summary stat tile (e.g. "STOP / HOLD: 2"). Compact left-bordered card with
// an icon, big number, and an optional subtitle that disappears on xs to
// keep the row tight on mobile.
export function StatCard({
  icon,
  label,
  value,
  color,
  sub,
}: {
  icon: React.ReactElement;
  label: string;
  value: string | number;
  color: string;
  sub?: string;
}) {
  return (
    <Paper
      sx={{
        p: { xs: 1.5, sm: 2 },
        bgcolor: 'rgba(255,255,255,0.03)',
        borderLeft: `3px solid ${color}`,
        display: 'flex',
        alignItems: 'center',
        gap: { xs: 1, sm: 2 },
        transition: 'all 0.2s',
        '&:hover': { bgcolor: 'rgba(255,255,255,0.06)' },
        overflow: 'hidden',
      }}
    >
      <Box sx={{ color, display: 'flex', flexShrink: 0 }}>{icon}</Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography
          variant="body2"
          color="text.secondary"
          noWrap
          sx={{ fontSize: { xs: 11, sm: 11 }, textTransform: 'uppercase', letterSpacing: 0.5 }}
        >
          {label}
        </Typography>
        <Typography
          variant="h6"
          sx={{ fontSize: { xs: 18, sm: 20 }, fontWeight: 700, lineHeight: 1.2 }}
        >
          {value}
        </Typography>
        {sub && (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ display: { xs: 'none', sm: 'block' }, fontSize: 11 }}
          >
            {sub}
          </Typography>
        )}
      </Box>
    </Paper>
  );
}

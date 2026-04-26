// client/src/components/OrgScopeBanner.tsx
import React from 'react';
import { Box, Typography, Button } from '@mui/material';
import BusinessIcon from '@mui/icons-material/Business';
import { useCurrentUser } from '../App';
import { useOrgScope } from '../OrgScope';

/**
 * Persistent banner that reminds super_admin which tenant they're acting as.
 * Renders only when:
 *   1. role === 'super_admin', AND
 *   2. a non-default org is selected (i.e. NOT FlashAware default).
 * Otherwise renders null so non-super users never see it.
 *
 * Mounted at layout level (App.tsx) so it appears on every page during a
 * cross-tenant session — destructive writes always have a visible reminder.
 */
export default function OrgScopeBanner() {
  const user = useCurrentUser();
  const { scopedOrgId, scopedOrgName, setScopedOrgId } = useOrgScope();

  if (user?.role !== 'super_admin') return null;
  if (!scopedOrgId) return null;

  return (
    <Box
      sx={{
        bgcolor: 'warning.dark',
        color: 'warning.contrastText',
        px: 2, py: 0.75,
        display: 'flex', alignItems: 'center', gap: 1,
        fontSize: 13, fontWeight: 500,
        borderBottom: '1px solid rgba(0,0,0,0.2)',
      }}
      role="status"
      aria-live="polite"
    >
      <BusinessIcon sx={{ fontSize: 18 }} />
      <Typography sx={{ flex: 1, fontSize: 13, fontWeight: 600 }}>
        Acting as <span style={{ textDecoration: 'underline' }}>{scopedOrgName}</span> — every action affects this tenant's data.
      </Typography>
      <Button
        size="small"
        color="inherit"
        variant="outlined"
        onClick={() => setScopedOrgId(null)}
        sx={{ borderColor: 'currentColor', fontSize: 11 }}
      >
        Switch back to All
      </Button>
    </Box>
  );
}

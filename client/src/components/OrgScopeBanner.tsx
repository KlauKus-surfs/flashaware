// client/src/components/OrgScopeBanner.tsx
import React from 'react';
import { Box, Typography, Button } from '@mui/material';
import BusinessIcon from '@mui/icons-material/Business';
import { useLocation } from 'react-router-dom';
import { useCurrentUser } from '../App';
import { useOrgScope } from '../OrgScope';

/**
 * Persistent banner that reminds super_admin which tenant they're acting as.
 * Mounted at layout level so it appears on every data-bearing page during a
 * cross-tenant session — destructive writes always have a visible reminder.
 *
 *   • Scoped to a tenant: warning-coloured strip ("Acting as Acme Corp …").
 *   • Unscoped (cross-org view): info-coloured strip telling them their writes
 *     default to their own (platform) tenant unless they pick one. This was
 *     the most common cross-tenant footgun before — silently writing customer
 *     data into the platform org.
 *   • Hidden on /platform and /orgs because those pages are inherently
 *     cross-tenant; the banner there is redundant noise.
 *   • Non-super users see nothing.
 */
export default function OrgScopeBanner() {
  const user = useCurrentUser();
  const { scopedOrgId, scopedOrgName, setScopedOrgId } = useOrgScope();
  const { pathname } = useLocation();

  if (user?.role !== 'super_admin') return null;
  if (pathname === '/platform' || pathname === '/orgs') return null;

  if (scopedOrgId) {
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

  // Unscoped: super_admin is viewing the cross-org aggregate, but any write
  // (create location, save settings, generate invite without an explicit org)
  // lands in their own tenant. Surface this so it's never a surprise.
  const platformOrg = user?.org_name || 'the platform tenant';
  return (
    <Box
      sx={{
        bgcolor: 'info.dark',
        color: 'info.contrastText',
        px: 2, py: 0.5,
        display: 'flex', alignItems: 'center', gap: 1,
        fontSize: 12,
        borderBottom: '1px solid rgba(0,0,0,0.2)',
      }}
      role="status"
      aria-live="polite"
    >
      <BusinessIcon sx={{ fontSize: 16 }} />
      <Typography sx={{ flex: 1, fontSize: 12 }}>
        Cross-org view — new writes default to <strong>{platformOrg}</strong>. Pick a tenant in the top bar to act on their data.
      </Typography>
    </Box>
  );
}

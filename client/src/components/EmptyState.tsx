// client/src/components/EmptyState.tsx
import React from 'react';
import { Box, Typography, Button } from '@mui/material';
import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description?: string;
  cta?: { label: string; onClick: () => void; icon?: ReactNode };
  secondaryCta?: { label: string; onClick: () => void };
}

/**
 * Shared empty-state used by Dashboard, Locations, Alerts, Audit, Replay.
 * Always at least one CTA — empty states without a path forward are
 * confusing for first-time users.
 */
export default function EmptyState({ icon, title, description, cta, secondaryCta }: EmptyStateProps) {
  return (
    <Box sx={{ textAlign: 'center', py: 6, px: 2 }}>
      <Box sx={{ color: 'text.secondary', mb: 1, '& > svg': { fontSize: 48 } }}>{icon}</Box>
      <Typography variant="h6" sx={{ fontSize: 16, mb: 0.5 }}>{title}</Typography>
      {description && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: cta ? 2 : 0, maxWidth: 480, mx: 'auto' }}>
          {description}
        </Typography>
      )}
      <Box sx={{ display: 'flex', gap: 1, justifyContent: 'center', flexWrap: 'wrap', mt: 2 }}>
        {cta && (
          <Button variant="contained" startIcon={cta.icon} onClick={cta.onClick}>
            {cta.label}
          </Button>
        )}
        {secondaryCta && (
          <Button variant="outlined" onClick={secondaryCta.onClick}>{secondaryCta.label}</Button>
        )}
      </Box>
    </Box>
  );
}

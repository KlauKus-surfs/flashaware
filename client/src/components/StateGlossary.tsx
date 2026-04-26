// client/src/components/StateGlossary.tsx
import React, { useState } from 'react';
import { Dialog, DialogTitle, DialogContent, IconButton, Box, Typography, Tooltip } from '@mui/material';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import CloseIcon from '@mui/icons-material/Close';
import { STATE_CONFIG, RiskState } from '../states';

const ORDER: RiskState[] = ['STOP', 'HOLD', 'PREPARE', 'ALL_CLEAR', 'DEGRADED'];

export default function StateGlossaryButton({ size = 'small' }: { size?: 'small' | 'medium' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip title="What do these states mean?">
        <IconButton size={size} onClick={() => setOpen(true)} aria-label="State glossary">
          <HelpOutlineIcon fontSize={size} />
        </IconButton>
      </Tooltip>
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Risk state guide
          <IconButton onClick={() => setOpen(false)} aria-label="Close"><CloseIcon /></IconButton>
        </DialogTitle>
        <DialogContent>
          {ORDER.map(s => {
            const cfg = STATE_CONFIG[s];
            return (
              <Box key={s} sx={{ display: 'flex', gap: 2, mb: 2 }}>
                <Box sx={{ minWidth: 90 }}>
                  <Box sx={{
                    display: 'inline-block', px: 1, py: 0.5,
                    bgcolor: cfg.color, color: cfg.textColor, fontWeight: 700,
                    fontSize: 11, borderRadius: 1, letterSpacing: 0.5,
                  }}>
                    {cfg.label}
                  </Box>
                </Box>
                <Typography variant="body2" sx={{ flex: 1 }}>{cfg.long}</Typography>
              </Box>
            );
          })}
        </DialogContent>
      </Dialog>
    </>
  );
}

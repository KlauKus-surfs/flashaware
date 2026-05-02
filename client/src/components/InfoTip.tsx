import React, { useState } from 'react';
import {
  IconButton,
  Popover,
  Dialog,
  DialogTitle,
  DialogContent,
  Box,
  Typography,
} from '@mui/material';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import CloseIcon from '@mui/icons-material/Close';

// Reusable inline-help affordance. Renders a small (i) icon. Click opens a
// Popover (default) or Dialog (`variant="dialog"`) with the help body. Click
// works on both touch and desktop, which matters because most operators run
// FlashAware on tablets/phones where hover-only tooltips are invisible.
//
// Long copy lives in src/help/copy.ts. Pass plain text or any ReactNode as
// `body`. Use a Dialog variant when the body has multiple paragraphs, lists,
// or a small example so it has room to breathe.

type InfoTipProps = {
  title?: string;
  body: React.ReactNode;
  variant?: 'popover' | 'dialog';
  size?: 'small' | 'medium';
  // Aria label for the trigger. Defaults to the title or "More info".
  ariaLabel?: string;
  // For inline placement next to a label (e.g., a TextField label) — shrinks
  // padding so the icon hugs the adjacent text.
  inline?: boolean;
};

export default function InfoTip({
  title,
  body,
  variant = 'popover',
  size = 'small',
  ariaLabel,
  inline,
}: InfoTipProps) {
  const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const open = variant === 'dialog' ? dialogOpen : Boolean(anchorEl);

  const handleOpen = (e: React.MouseEvent<HTMLButtonElement>) => {
    // Stop propagation so an InfoTip embedded inside a clickable row/card
    // doesn't also trigger the row's onClick (e.g., navigation, expand).
    e.stopPropagation();
    e.preventDefault();
    if (variant === 'dialog') setDialogOpen(true);
    else setAnchorEl(e.currentTarget);
  };

  const handleClose = (e?: React.SyntheticEvent | unknown) => {
    if (
      e &&
      typeof e === 'object' &&
      'stopPropagation' in e &&
      typeof (e as React.SyntheticEvent).stopPropagation === 'function'
    ) {
      (e as React.SyntheticEvent).stopPropagation();
    }
    setAnchorEl(null);
    setDialogOpen(false);
  };

  const trigger = (
    <IconButton
      size={size}
      onClick={handleOpen}
      aria-label={ariaLabel ?? title ?? 'More info'}
      sx={{
        p: inline ? 0.25 : 0.5,
        ml: inline ? 0.25 : 0,
        color: 'text.secondary',
        '&:hover': { color: 'primary.main' },
      }}
    >
      <HelpOutlineIcon sx={{ fontSize: inline ? 16 : 18 }} />
    </IconButton>
  );

  if (variant === 'dialog') {
    return (
      <>
        {trigger}
        <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
          <DialogTitle
            sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pr: 1 }}
          >
            {title ?? 'About'}
            <IconButton onClick={handleClose} aria-label="Close" size="small">
              <CloseIcon fontSize="small" />
            </IconButton>
          </DialogTitle>
          <DialogContent>
            <Box sx={{ '& p': { mt: 0 }, '& p + p': { mt: 1.5 } }}>
              {typeof body === 'string' ? <Typography variant="body2">{body}</Typography> : body}
            </Box>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  return (
    <>
      {trigger}
      <Popover
        open={open}
        anchorEl={anchorEl}
        onClose={handleClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{ paper: { sx: { maxWidth: 360, p: 2 } } }}
      >
        {title && (
          <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.75 }}>
            {title}
          </Typography>
        )}
        {typeof body === 'string' ? (
          <Typography variant="body2" sx={{ lineHeight: 1.5 }}>
            {body}
          </Typography>
        ) : (
          <Box sx={{ '& p': { mt: 0 }, '& p + p': { mt: 1 } }}>{body}</Box>
        )}
      </Popover>
    </>
  );
}

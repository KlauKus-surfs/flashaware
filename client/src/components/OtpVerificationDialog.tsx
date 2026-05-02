import React from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Typography,
  Button,
  CircularProgress,
} from '@mui/material';
import { PhoneVerificationState } from '../hooks/usePhoneVerification';

const MAX_VERIFY_ATTEMPTS = 5;

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

interface Props {
  state: PhoneVerificationState;
  onCodeChange: (code: string) => void;
  onResend: () => void;
  onVerify: () => void;
  onClose: () => void;
}

// Pure-presentation OTP dialog. State is owned by usePhoneVerification in
// the parent; we only render and forward intents up. Drives a per-second
// re-render of the countdown via the parent's useTickWhileOpen() hook.
export function OtpVerificationDialog({ state, onCodeChange, onResend, onVerify, onClose }: Props) {
  const { recipient, code, sending, verifying, expiresAt, retryAt, attemptsRemaining } = state;
  const handleClose = () => {
    if (!verifying && !sending) onClose();
  };
  const codeIsValid = /^\d{6}$/.test(code.trim());
  const expired = !!(expiresAt && Date.now() >= expiresAt);
  const rateLimited = !!(retryAt && Date.now() < retryAt);

  return (
    <Dialog open={!!recipient} onClose={handleClose} maxWidth="xs" fullWidth>
      <DialogTitle>Verify phone number</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 2 }}>
          We sent a 6-digit code to <strong>{recipient?.phone}</strong>. Enter it below to enable
          SMS and WhatsApp alerts.
        </Typography>

        <TextField
          autoFocus
          fullWidth
          label="Verification code"
          value={code}
          onChange={(e) => onCodeChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
          inputProps={{
            inputMode: 'numeric',
            pattern: '[0-9]*',
            maxLength: 6,
            autoComplete: 'one-time-code',
          }}
          disabled={verifying}
          error={attemptsRemaining !== null && attemptsRemaining < MAX_VERIFY_ATTEMPTS}
          helperText={attemptsRemaining !== null ? `${attemptsRemaining} attempts remaining` : null}
        />

        {expiresAt && Date.now() < expiresAt && (
          <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'text.secondary' }}>
            Code expires in {formatCountdown(expiresAt - Date.now())}.
          </Typography>
        )}

        {expired && (
          <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'error.main' }}>
            Code has expired. Use "Resend code".
          </Typography>
        )}

        {rateLimited && retryAt && (
          <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'warning.main' }}>
            Too many code requests. Try again in {formatCountdown(retryAt - Date.now())}.
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={verifying}>
          Cancel
        </Button>
        <Button onClick={onResend} disabled={sending || verifying || rateLimited}>
          {sending ? 'Sending…' : 'Resend code'}
        </Button>
        <Button
          variant="contained"
          onClick={onVerify}
          disabled={verifying || !codeIsValid || expired}
          startIcon={verifying ? <CircularProgress size={14} /> : null}
        >
          Verify
        </Button>
      </DialogActions>
    </Dialog>
  );
}

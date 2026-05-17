import React, { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Box, Paper, Typography, TextField, Button, Alert, Link as MuiLink } from '@mui/material';
import FlashOnIcon from '@mui/icons-material/FlashOn';
import MarkEmailReadIcon from '@mui/icons-material/MarkEmailRead';
import { forgotPassword } from './api';
import LightningBackground from './components/LightningBackground';
import AppVersionChip from './components/AppVersionChip';

/**
 * Request-a-reset screen. The server always responds 200 (no account
 * enumeration), so this UI commits to the "we sent it if you have one"
 * messaging regardless of the actual outcome. The "Resend" link costs a
 * round-trip but lands on the same uniform response; the per-user throttle
 * on the server is what actually prevents inbox flooding.
 */
export default function Forgot() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setSubmitting(true);
    try {
      await forgotPassword(email.trim());
    } catch {
      // The endpoint is documented to always 200; treat anything else as a
      // transient failure but still show the success view so we don't leak
      // "we have this account / we don't" via different error UX.
    } finally {
      setSubmitting(false);
      setSent(true);
    }
  };

  return (
    <LightningBackground>
      <Box
        sx={{
          flexGrow: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          p: 2,
        }}
      >
        <Paper
          elevation={6}
          sx={{
            p: { xs: 3, sm: 4 },
            maxWidth: 400,
            width: '100%',
            backgroundColor: (t) =>
              t.palette.mode === 'dark' ? 'rgba(19,47,76,0.92)' : 'rgba(255,255,255,0.96)',
            backdropFilter: 'blur(6px)',
            border: (t) =>
              t.palette.mode === 'dark'
                ? '1px solid rgba(255,255,255,0.06)'
                : '1px solid rgba(0,0,0,0.06)',
          }}
        >
          <Box sx={{ textAlign: 'center', mb: 3 }}>
            <FlashOnIcon sx={{ fontSize: 48, color: '#fbc02d' }} />
            <Typography variant="h5" sx={{ mt: 1, fontWeight: 700 }}>
              {sent ? 'Check your inbox' : 'Reset your password'}
            </Typography>
            {!sent && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                Enter your account email and we'll send a reset link.
              </Typography>
            )}
          </Box>

          {sent ? (
            <>
              <Alert
                severity="success"
                icon={<MarkEmailReadIcon fontSize="inherit" />}
                sx={{ mb: 2 }}
              >
                If an account with that email exists, a reset link is on its way. The link expires
                in 30 minutes.
              </Alert>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
                Didn't get it? Check your spam folder. You can also{' '}
                <MuiLink
                  component="button"
                  type="button"
                  underline="hover"
                  onClick={() => {
                    setSent(false);
                  }}
                >
                  try again
                </MuiLink>
                .
              </Typography>
              <Button fullWidth variant="contained" component={RouterLink} to="/">
                Back to sign in
              </Button>
            </>
          ) : (
            <form onSubmit={handleSubmit}>
              <TextField
                fullWidth
                label="Email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                sx={{ mb: 3 }}
                size="small"
                autoFocus
                required
                inputProps={{ name: 'email', autoComplete: 'email' }}
              />
              <Button
                fullWidth
                variant="contained"
                type="submit"
                disabled={submitting || !email.trim()}
                size="large"
              >
                {submitting ? 'Sending…' : 'Send reset link'}
              </Button>
              <Box sx={{ mt: 2.5, textAlign: 'center' }}>
                <MuiLink
                  component={RouterLink}
                  to="/"
                  underline="hover"
                  variant="caption"
                  color="text.secondary"
                >
                  Back to sign in
                </MuiLink>
              </Box>
            </form>
          )}
        </Paper>
      </Box>
      <AppVersionChip />
    </LightningBackground>
  );
}

import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, Link as RouterLink } from 'react-router-dom';
import {
  Box,
  Paper,
  Typography,
  TextField,
  Button,
  Alert,
  CircularProgress,
  Link as MuiLink,
} from '@mui/material';
import FlashOnIcon from '@mui/icons-material/FlashOn';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { resetPassword, verifyResetToken } from './api';
import LightningBackground from './components/LightningBackground';
import AppVersionChip from './components/AppVersionChip';

const MIN_LEN = 12; // mirror server's MIN_PASSWORD_LENGTH

/**
 * Token landing page for /reset/:token. Verifies the token up front so a
 * stale link surfaces "this link expired" immediately instead of after the
 * user has typed (and retyped) a new password. Real validation still
 * happens server-side on submit — this is just UX.
 */
export default function ResetPassword() {
  const { token = '' } = useParams<{ token: string }>();
  const navigate = useNavigate();

  const [verifying, setVerifying] = useState(true);
  const [tokenValid, setTokenValid] = useState(false);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setVerifying(false);
      setTokenValid(false);
      return;
    }
    verifyResetToken(token)
      .then((r) => {
        if (!cancelled) setTokenValid(r.data.valid);
      })
      .catch(() => {
        if (!cancelled) setTokenValid(false);
      })
      .finally(() => {
        if (!cancelled) setVerifying(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const canSubmit = !submitting && password.length >= MIN_LEN && password === confirm && tokenValid;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setServerError('');
    try {
      await resetPassword(token, password);
      setDone(true);
    } catch (err: any) {
      setServerError(err?.response?.data?.error || 'Password reset failed.');
    } finally {
      setSubmitting(false);
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
            maxWidth: 420,
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
              Set a new password
            </Typography>
          </Box>

          {verifying && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
              <CircularProgress />
            </Box>
          )}

          {!verifying && !tokenValid && !done && (
            <>
              <Alert severity="error" sx={{ mb: 2 }}>
                This reset link is invalid or has expired. Request a new one to continue.
              </Alert>
              <Button fullWidth variant="contained" component={RouterLink} to="/forgot">
                Request a new link
              </Button>
              <Box sx={{ mt: 2, textAlign: 'center' }}>
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
            </>
          )}

          {done && (
            <Box sx={{ textAlign: 'center' }}>
              <CheckCircleIcon sx={{ fontSize: 56, color: 'success.main', mb: 1 }} />
              <Typography variant="h6" sx={{ mb: 1 }}>
                Password updated
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                You can now sign in with your new password.
              </Typography>
              <Button fullWidth variant="contained" onClick={() => navigate('/')}>
                Go to sign in
              </Button>
            </Box>
          )}

          {!verifying && tokenValid && !done && (
            <form onSubmit={handleSubmit}>
              {serverError && (
                <Alert severity="error" sx={{ mb: 2 }}>
                  {serverError}
                </Alert>
              )}
              <TextField
                fullWidth
                label="New password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                sx={{ mb: 2 }}
                size="small"
                required
                autoFocus
                helperText={`At least ${MIN_LEN} characters and not on the default-password block list.`}
                inputProps={{ autoComplete: 'new-password' }}
              />
              <TextField
                fullWidth
                label="Confirm new password"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                sx={{ mb: 3 }}
                size="small"
                required
                error={confirm.length > 0 && password !== confirm}
                helperText={
                  confirm.length > 0 && password !== confirm ? 'Passwords do not match' : ''
                }
                inputProps={{ autoComplete: 'new-password' }}
              />
              <Button
                fullWidth
                variant="contained"
                type="submit"
                disabled={!canSubmit}
                size="large"
              >
                {submitting ? 'Updating…' : 'Update password'}
              </Button>
            </form>
          )}
        </Paper>
      </Box>
      <AppVersionChip />
    </LightningBackground>
  );
}

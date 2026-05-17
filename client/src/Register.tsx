import React, { useState, useEffect } from 'react';
import { useSearchParams, useNavigate, Link as RouterLink } from 'react-router-dom';
import {
  Box,
  Paper,
  Typography,
  TextField,
  Button,
  Alert,
  CircularProgress,
  Chip,
  Divider,
  Link as MuiLink,
} from '@mui/material';
import FlashOnIcon from '@mui/icons-material/FlashOn';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import api, { loginApi } from './api';
import LightningBackground from './components/LightningBackground';
import AppVersionChip from './components/AppVersionChip';

// onLogin is the same callback the LoginPage uses, threaded down from App
// so a successful registration can transition the user straight onto the
// dashboard instead of bouncing them through a manual sign-in. Optional —
// if not provided (e.g. a future standalone mount) the page falls back to
// the previous "Go to Sign In" UX.
interface RegisterProps {
  onLogin?: (
    user: { id: string; email: string; name: string; role: string; org_id?: string },
    token: string,
    csrfToken?: string,
  ) => void;
}

interface InviteInfo {
  valid: boolean;
  org_name: string;
  role: string;
  email: string | null;
}

const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  operator: 'Operator',
  viewer: 'Viewer',
};

export default function Register({ onLogin }: RegisterProps = {}) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token') || '';

  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [tokenError, setTokenError] = useState('');
  const [tokenLoading, setTokenLoading] = useState(true);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!token) {
      setTokenError(
        'No invite token found in the URL. Please use the link provided in your invitation.',
      );
      setTokenLoading(false);
      return;
    }
    api
      .get(`/orgs/invites/${token}/validate`)
      .then((res) => {
        setInvite(res.data);
        if (res.data.email) setEmail(res.data.email);
      })
      .catch((err) => {
        setTokenError(err.response?.data?.error || 'Invalid or expired invite link.');
      })
      .finally(() => setTokenLoading(false));
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      setSubmitError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    setSubmitError('');
    try {
      const trimmedEmail = email.trim();
      await api.post('/orgs/register', {
        token,
        name: name.trim(),
        email: trimmedEmail,
        password,
      });
      // Auto-login: the user just typed correct credentials. Drop them
      // straight on the dashboard instead of asking them to retype the
      // same password into the login screen. We always render the success
      // panel as a fallback so a login failure (e.g. transient 5xx) still
      // surfaces a usable button — but a successful login pre-empts it
      // by calling navigate('/') after onLogin updates the App state.
      try {
        const res = await loginApi(trimmedEmail, password);
        if (onLogin) {
          onLogin(res.data.user, res.data.token, res.data.csrfToken);
          navigate('/');
          return;
        }
      } catch (loginErr) {
        // Non-fatal: fall through to the success panel and let the user
        // sign in manually. This branch hits when the server accepted the
        // registration but rejected the immediate login (rate-limited from
        // a noisy invite link, transient 5xx, etc.).
      }
      setSuccess(true);
    } catch (err: any) {
      setSubmitError(err.response?.data?.error || 'Registration failed. Please try again.');
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
            maxWidth: 440,
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
          {/* Header */}
          <Box sx={{ textAlign: 'center', mb: 3 }}>
            <FlashOnIcon sx={{ fontSize: 48, color: '#fbc02d' }} />
            <Typography variant="h5" sx={{ mt: 1, fontWeight: 700 }}>
              FlashAware
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Create your account
            </Typography>
          </Box>

          {/* Loading */}
          {tokenLoading && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
              <CircularProgress />
            </Box>
          )}

          {/* Invalid token */}
          {!tokenLoading && tokenError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {tokenError}
            </Alert>
          )}

          {/* Success state */}
          {success && (
            <Box sx={{ textAlign: 'center' }}>
              <CheckCircleIcon sx={{ fontSize: 56, color: 'success.main', mb: 1 }} />
              <Typography variant="h6" sx={{ mb: 1 }}>
                Account Created!
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                Your account has been created for <strong>{invite?.org_name}</strong>. You can now
                sign in.
              </Typography>
              <Button variant="contained" fullWidth onClick={() => navigate('/')}>
                Go to Sign In
              </Button>
            </Box>
          )}

          {/* Registration form */}
          {!tokenLoading && !tokenError && !success && invite && (
            <>
              {/* Invite context banner */}
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.5,
                  p: 1.5,
                  mb: 3,
                  borderRadius: 2,
                  bgcolor: 'rgba(251,192,45,0.08)',
                  border: '1px solid rgba(251,192,45,0.25)',
                }}
              >
                <Box sx={{ flexGrow: 1 }}>
                  <Typography variant="body2" fontWeight={600}>
                    {invite.org_name}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    You're joining as
                  </Typography>
                </Box>
                <Chip
                  label={ROLE_LABELS[invite.role] || invite.role}
                  size="small"
                  color="primary"
                  variant="outlined"
                />
              </Box>

              {submitError && (
                <Alert severity="error" sx={{ mb: 2 }}>
                  {submitError}
                </Alert>
              )}

              <form onSubmit={handleSubmit}>
                <TextField
                  fullWidth
                  label="Full Name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  sx={{ mb: 2 }}
                  size="small"
                  required
                  placeholder="Jane Smith"
                  inputProps={{ autoComplete: 'name' }}
                  autoFocus
                />
                <TextField
                  fullWidth
                  label="Email Address"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  sx={{ mb: 2 }}
                  size="small"
                  required
                  disabled={!!invite.email}
                  helperText={invite.email ? 'Email is locked to this invite' : ''}
                  inputProps={{ autoComplete: 'username email' }}
                />
                <TextField
                  fullWidth
                  label="Password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  sx={{ mb: 2 }}
                  size="small"
                  required
                  helperText="At least 6 characters"
                  inputProps={{ autoComplete: 'new-password' }}
                />
                <TextField
                  fullWidth
                  label="Confirm Password"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  sx={{ mb: 3 }}
                  size="small"
                  required
                  error={confirmPassword.length > 0 && password !== confirmPassword}
                  helperText={
                    confirmPassword.length > 0 && password !== confirmPassword
                      ? 'Passwords do not match'
                      : ''
                  }
                  inputProps={{ autoComplete: 'new-password' }}
                />
                <Button
                  fullWidth
                  variant="contained"
                  type="submit"
                  size="large"
                  disabled={
                    submitting ||
                    !name.trim() ||
                    !email.trim() ||
                    !password ||
                    password !== confirmPassword
                  }
                >
                  {submitting ? 'Creating Account…' : 'Create Account'}
                </Button>
              </form>

              <Divider sx={{ my: 2 }} />
              <Typography variant="body2" color="text.secondary" align="center">
                Already have an account?{' '}
                <MuiLink component={RouterLink} to="/" underline="hover" color="primary.main">
                  Sign in
                </MuiLink>
              </Typography>
            </>
          )}
        </Paper>
      </Box>
      <AppVersionChip />
    </LightningBackground>
  );
}

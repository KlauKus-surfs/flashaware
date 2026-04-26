import React, { useState, useEffect } from 'react';
import { useSearchParams, useNavigate, Link as RouterLink } from 'react-router-dom';
import {
  Box, Paper, Typography, TextField, Button, Alert,
  CircularProgress, Chip, Divider, Link as MuiLink,
} from '@mui/material';
import FlashOnIcon from '@mui/icons-material/FlashOn';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import api from './api';

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

export default function Register() {
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
      setTokenError('No invite token found in the URL. Please use the link provided in your invitation.');
      setTokenLoading(false);
      return;
    }
    api.get(`/orgs/invites/${token}/validate`)
      .then(res => {
        setInvite(res.data);
        if (res.data.email) setEmail(res.data.email);
      })
      .catch(err => {
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
      await api.post('/orgs/register', { token, name: name.trim(), email: email.trim(), password });
      setSuccess(true);
    } catch (err: any) {
      setSubmitError(err.response?.data?.error || 'Registration failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Box sx={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      bgcolor: 'background.default',
      p: 2,
    }}>
      <Paper sx={{ p: 4, maxWidth: 440, width: '100%' }}>
        {/* Header */}
        <Box sx={{ textAlign: 'center', mb: 3 }}>
          <FlashOnIcon sx={{ fontSize: 48, color: 'primary.main' }} />
          <Typography variant="h5" sx={{ mt: 1, fontWeight: 700 }}>FlashAware</Typography>
          <Typography variant="body2" color="text.secondary">Create your account</Typography>
        </Box>

        {/* Loading */}
        {tokenLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        )}

        {/* Invalid token */}
        {!tokenLoading && tokenError && (
          <Alert severity="error" sx={{ mb: 2 }}>{tokenError}</Alert>
        )}

        {/* Success state */}
        {success && (
          <Box sx={{ textAlign: 'center' }}>
            <CheckCircleIcon sx={{ fontSize: 56, color: 'success.main', mb: 1 }} />
            <Typography variant="h6" sx={{ mb: 1 }}>Account Created!</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              Your account has been created for <strong>{invite?.org_name}</strong>. You can now sign in.
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
            <Box sx={{
              display: 'flex', alignItems: 'center', gap: 1.5,
              p: 1.5, mb: 3, borderRadius: 2,
              bgcolor: 'rgba(251,192,45,0.08)',
              border: '1px solid rgba(251,192,45,0.25)',
            }}>
              <Box sx={{ flexGrow: 1 }}>
                <Typography variant="body2" fontWeight={600}>{invite.org_name}</Typography>
                <Typography variant="caption" color="text.secondary">You're joining as</Typography>
              </Box>
              <Chip
                label={ROLE_LABELS[invite.role] || invite.role}
                size="small"
                color="primary"
                variant="outlined"
              />
            </Box>

            {submitError && <Alert severity="error" sx={{ mb: 2 }}>{submitError}</Alert>}

            <form onSubmit={handleSubmit}>
              <TextField
                fullWidth label="Full Name" value={name}
                onChange={e => setName(e.target.value)}
                sx={{ mb: 2 }} size="small" required
                placeholder="Jane Smith"
              />
              <TextField
                fullWidth label="Email Address" type="email" value={email}
                onChange={e => setEmail(e.target.value)}
                sx={{ mb: 2 }} size="small" required
                disabled={!!invite.email}
                helperText={invite.email ? 'Email is locked to this invite' : ''}
              />
              <TextField
                fullWidth label="Password" type="password" value={password}
                onChange={e => setPassword(e.target.value)}
                sx={{ mb: 2 }} size="small" required
                helperText="At least 6 characters"
              />
              <TextField
                fullWidth label="Confirm Password" type="password" value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                sx={{ mb: 3 }} size="small" required
                error={confirmPassword.length > 0 && password !== confirmPassword}
                helperText={confirmPassword.length > 0 && password !== confirmPassword ? 'Passwords do not match' : ''}
              />
              <Button
                fullWidth variant="contained" type="submit" size="large"
                disabled={submitting || !name.trim() || !email.trim() || !password || password !== confirmPassword}
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
  );
}

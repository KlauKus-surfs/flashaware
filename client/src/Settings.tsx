import React, { useState, useEffect } from 'react';
import {
  Box, Card, CardContent, Typography, Grid, TextField, Button, Switch,
  FormControlLabel, Chip, Alert, Paper,
  Accordion, AccordionSummary, AccordionDetails, LinearProgress,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import SaveIcon from '@mui/icons-material/Save';
import TuneIcon from '@mui/icons-material/Tune';
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive';
import SecurityIcon from '@mui/icons-material/Security';
import StorageIcon from '@mui/icons-material/Storage';
import SpeedIcon from '@mui/icons-material/Speed';
import SendIcon from '@mui/icons-material/Send';
import LockIcon from '@mui/icons-material/Lock';
import { Link as RouterLink } from 'react-router-dom';
import { getHealth, getSettings, saveSettings, sendTestEmail } from './api';
import { useCurrentUser } from './App';
import { useOrgScope } from './OrgScope';
import { useToast } from './components/ToastProvider';

interface GlobalThresholds {
  defaultStopRadiusKm: number;
  defaultPrepareRadiusKm: number;
  defaultStopFlashThreshold: number;
  defaultStopWindowMin: number;
  defaultPrepareFlashThreshold: number;
  defaultPrepareWindowMin: number;
  defaultAllclearWaitMin: number;
  staleDataThresholdMin: number;
  flashConfidenceMin: number;
  flashDurationMaxMs: number;
}

interface NotificationSettings {
  emailEnabled: boolean;
  smsEnabled: boolean;
  escalationEnabled: boolean;
  escalationDelayMin: number;
  smtpHost: string;
  alertFromAddress: string;
}

export default function Settings() {
  const currentUser = useCurrentUser();
  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'super_admin';
  const isSuperAdmin = currentUser?.role === 'super_admin';
  const { scopedOrgId, scopedOrgName } = useOrgScope();
  const toast = useToast();

  const [health, setHealth] = useState<any>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [testEmailTo, setTestEmailTo] = useState('');
  const [testEmailSending, setTestEmailSending] = useState(false);

  const thresholds: GlobalThresholds = {
    defaultStopRadiusKm: 10,
    defaultPrepareRadiusKm: 20,
    defaultStopFlashThreshold: 3,
    defaultStopWindowMin: 5,
    defaultPrepareFlashThreshold: 1,
    defaultPrepareWindowMin: 15,
    defaultAllclearWaitMin: 30,
    staleDataThresholdMin: 25,
    flashConfidenceMin: 0.5,
    flashDurationMaxMs: 600,
  };

  const [notifications, setNotifications] = useState<NotificationSettings>({
    emailEnabled: true,
    smsEnabled: false,
    escalationEnabled: true,
    escalationDelayMin: 5,
    smtpHost: 'smtp.gmail.com',
    alertFromAddress: 'alerts@flashaware.io',
  });

  const dataRetention = {
    flashRetentionDays: 90,
    stateRetentionDays: 365,
    alertRetentionDays: 365,
    logRetentionDays: 30,
  };

  useEffect(() => {
    getHealth().then(res => setHealth(res.data)).catch(console.error);
    if (isAdmin) {
      // super_admin scoped to a specific org reads/writes that org's settings;
      // otherwise the server defaults to the caller's own org.
      getSettings(scopedOrgId ?? undefined).then(res => {
        const s = res.data as Record<string, string>;
        setNotifications(prev => ({
          ...prev,
          emailEnabled:       s['email_enabled']        !== 'false',
          smsEnabled:         s['sms_enabled']          === 'true',
          escalationEnabled:  s['escalation_enabled']   !== 'false',
          escalationDelayMin: s['escalation_delay_min'] ? +s['escalation_delay_min'] : 10,
          alertFromAddress:   s['alert_from_address']   || 'alerts@flashaware.io',
        }));
      }).catch(console.error);
    }
  }, [isAdmin, scopedOrgId]);

  const handleSaveNotifications = async () => {
    setSettingsSaving(true);
    try {
      await saveSettings({
        email_enabled:        String(notifications.emailEnabled),
        sms_enabled:          String(notifications.smsEnabled),
        escalation_enabled:   String(notifications.escalationEnabled),
        escalation_delay_min: String(notifications.escalationDelayMin),
        alert_from_address:   notifications.alertFromAddress,
      }, scopedOrgId ?? undefined);
      toast.success('Notification settings saved');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to save settings');
    } finally {
      setSettingsSaving(false);
    }
  };

  const handleSendTestEmail = async () => {
    if (!testEmailTo.trim() || !/.+@.+\..+/.test(testEmailTo)) {
      toast.error('Enter a valid email address');
      return;
    }
    setTestEmailSending(true);
    try {
      await sendTestEmail(testEmailTo.trim());
      toast.success(`Test email sent to ${testEmailTo}`);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to send test email');
    } finally {
      setTestEmailSending(false);
    }
  };

  return (
    <Box>
      <Typography variant="h4" sx={{ fontSize: { xs: 18, sm: 24 }, mb: 0.5 }}>Settings</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        System configuration, thresholds, notifications, and user management.
      </Typography>

      {/* System Status */}
      <Card sx={{ mb: 3, border: '1px solid rgba(255,255,255,0.08)' }}>
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2 }}>
            <SpeedIcon sx={{ color: 'primary.main' }} />
            <Typography variant="h6" sx={{ fontSize: 16 }}>System Status</Typography>
            {health && (
              <Chip
                label={health.mode === 'live-eumetsat' ? 'LIVE EUMETSAT' : health.mode === 'in-memory-mock' ? 'MOCK MODE' : 'PRODUCTION'}
                size="small"
                color={health.mode === 'in-memory-mock' ? 'warning' : 'success'}
                sx={{ fontWeight: 700, fontSize: 11 }}
              />
            )}
          </Box>
          {health ? (
            <Grid container spacing={3}>
              <Grid item xs={6} sm={3}>
                <Paper sx={{ p: 2, bgcolor: 'rgba(255,255,255,0.03)', textAlign: 'center' }}>
                  <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11, mb: 0.5 }}>SERVER</Typography>
                  <Chip label={health.status === 'ok' ? 'Online' : 'Error'} size="small"
                    color={health.status === 'ok' ? 'success' : 'error'} sx={{ fontWeight: 600 }} />
                </Paper>
              </Grid>
              <Grid item xs={6} sm={3}>
                <Paper sx={{ p: 2, bgcolor: 'rgba(255,255,255,0.03)', textAlign: 'center' }}>
                  <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11, mb: 0.5 }}>DATA FEED</Typography>
                  <Chip label={health.feedHealthy ? 'Healthy' : 'Degraded'} size="small"
                    color={health.feedHealthy ? 'success' : 'error'} sx={{ fontWeight: 600 }} />
                </Paper>
              </Grid>
              <Grid item xs={6} sm={3}>
                <Paper sx={{ p: 2, bgcolor: 'rgba(255,255,255,0.03)', textAlign: 'center' }}>
                  <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11, mb: 0.5 }}>FLASH EVENTS</Typography>
                  <Typography variant="h6" sx={{ fontSize: 20 }}>{health.flashCount ?? '—'}</Typography>
                </Paper>
              </Grid>
              <Grid item xs={6} sm={3}>
                <Paper sx={{ p: 2, bgcolor: 'rgba(255,255,255,0.03)', textAlign: 'center' }}>
                  <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11, mb: 0.5 }}>DATA AGE</Typography>
                  <Typography variant="h6" sx={{ fontSize: 20, color: (health.dataAgeMinutes ?? 99) < 25 ? 'success.main' : 'error.main' }}>
                    {health.dataAgeMinutes ?? '?'} min
                  </Typography>
                </Paper>
              </Grid>
            </Grid>
          ) : (
            <LinearProgress />
          )}
        </CardContent>
      </Card>

      {!isAdmin && (
        <Alert severity="info" sx={{ mb: 3 }}>
          You have read-only access. Contact an administrator to change system settings.
        </Alert>
      )}

      {/* Global Thresholds — admin only, currently read-only reference values */}
      {isAdmin && <Accordion sx={{ mb: 2, bgcolor: 'background.paper', '&:before': { display: 'none' } }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <TuneIcon sx={{ color: 'primary.main' }} />
            <Typography variant="h6" sx={{ fontSize: 16 }}>Default Risk Thresholds</Typography>
            <Chip icon={<LockIcon />} label="Reference only" size="small" variant="outlined" sx={{ fontSize: 11 }} />
          </Box>
        </AccordionSummary>
        <AccordionDetails>
          <Alert severity="info" sx={{ mb: 2 }}>
            These are the platform-wide defaults baked into the risk engine. Per-location thresholds are configured under <strong>Locations</strong>. A future release will let admins edit these defaults from this page.
          </Alert>
          <Grid container spacing={2}>
            <Grid item xs={6} sm={4} md={3}>
              <TextField fullWidth label="STOP Radius (km)" type="number" size="small" disabled
                value={thresholds.defaultStopRadiusKm}
                helperText="Inner danger zone" />
            </Grid>
            <Grid item xs={6} sm={4} md={3}>
              <TextField fullWidth label="PREPARE Radius (km)" type="number" size="small" disabled
                value={thresholds.defaultPrepareRadiusKm}
                helperText="Outer awareness zone" />
            </Grid>
            <Grid item xs={6} sm={4} md={3}>
              <TextField fullWidth label="STOP Flash Threshold" type="number" size="small" disabled
                value={thresholds.defaultStopFlashThreshold}
                helperText="Flashes to trigger STOP" />
            </Grid>
            <Grid item xs={6} sm={4} md={3}>
              <TextField fullWidth label="STOP Window (min)" type="number" size="small" disabled
                value={thresholds.defaultStopWindowMin}
                helperText="Time window for STOP" />
            </Grid>
            <Grid item xs={6} sm={4} md={3}>
              <TextField fullWidth label="PREPARE Flash Threshold" type="number" size="small" disabled
                value={thresholds.defaultPrepareFlashThreshold}
                helperText="Flashes to trigger PREPARE" />
            </Grid>
            <Grid item xs={6} sm={4} md={3}>
              <TextField fullWidth label="PREPARE Window (min)" type="number" size="small" disabled
                value={thresholds.defaultPrepareWindowMin}
                helperText="Time window for PREPARE" />
            </Grid>
            <Grid item xs={6} sm={4} md={3}>
              <TextField fullWidth label="ALL CLEAR Wait (min)" type="number" size="small" disabled
                value={thresholds.defaultAllclearWaitMin}
                helperText="Min wait before ALL CLEAR" />
            </Grid>
            <Grid item xs={6} sm={4} md={3}>
              <TextField fullWidth label="Stale Data Threshold (min)" type="number" size="small" disabled
                value={thresholds.staleDataThresholdMin}
                helperText="Max data age before DEGRADED" />
            </Grid>
            <Grid item xs={6} sm={4} md={3}>
              <TextField fullWidth label="Min Flash Confidence" type="number" size="small" disabled
                value={thresholds.flashConfidenceMin} inputProps={{ step: 0.1, min: 0, max: 1 }}
                helperText="Filter confidence ≥ this" />
            </Grid>
            <Grid item xs={6} sm={4} md={3}>
              <TextField fullWidth label="Max Flash Duration (ms)" type="number" size="small" disabled
                value={thresholds.flashDurationMaxMs}
                helperText="P95 duration clamp" />
            </Grid>
          </Grid>
        </AccordionDetails>
      </Accordion>}

      {/* Notifications — admin only */}
      {isAdmin && <Accordion defaultExpanded sx={{ mb: 2, bgcolor: 'background.paper', '&:before': { display: 'none' } }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <NotificationsActiveIcon sx={{ color: 'primary.main' }} />
            <Typography variant="h6" sx={{ fontSize: 16 }}>Notification Settings</Typography>
          </Box>
        </AccordionSummary>
        <AccordionDetails>
          {isSuperAdmin && (
            <Alert severity="info" sx={{ mb: 2 }}>
              Editing settings for <strong>{scopedOrgName || 'FlashAware'}</strong>.
              {' '}Use the org picker in the top bar to switch tenants.
              {' '}Empty values fall back to platform defaults.
            </Alert>
          )}
          <Grid container spacing={2}>
            <Grid item xs={12}>
              <Box sx={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                <FormControlLabel
                  control={<Switch checked={notifications.emailEnabled}
                    onChange={e => setNotifications({ ...notifications, emailEnabled: e.target.checked })} />}
                  label="Email Alerts" />
                <FormControlLabel
                  control={<Switch checked={notifications.smsEnabled}
                    onChange={e => setNotifications({ ...notifications, smsEnabled: e.target.checked })} />}
                  label="SMS Alerts (Phase 2)" />
                <FormControlLabel
                  control={<Switch checked={notifications.escalationEnabled}
                    onChange={e => setNotifications({ ...notifications, escalationEnabled: e.target.checked })} />}
                  label="Auto-Escalation" />
              </Box>
            </Grid>
            <Grid item xs={6} sm={4}>
              <TextField fullWidth label="Escalation Delay (min)" type="number" size="small"
                value={notifications.escalationDelayMin}
                onChange={e => setNotifications({ ...notifications, escalationDelayMin: Math.max(1, +e.target.value) })}
                inputProps={{ min: 1 }}
                helperText="Minutes before escalating unacked alerts" />
            </Grid>
            <Grid item xs={6} sm={4}>
              <TextField fullWidth label="SMTP Host" size="small"
                value={notifications.smtpHost}
                onChange={e => setNotifications({ ...notifications, smtpHost: e.target.value })} />
            </Grid>
            <Grid item xs={6} sm={4}>
              <TextField fullWidth label="Alert From Address" size="small"
                value={notifications.alertFromAddress}
                onChange={e => setNotifications({ ...notifications, alertFromAddress: e.target.value })} />
            </Grid>
          </Grid>
          {health?.mode === 'in-memory-mock' && (
            <Alert severity="info" sx={{ mt: 2 }}>
              Running in mock mode — emails are logged to console only. Configure SMTP credentials in <code>.env</code> for production.
            </Alert>
          )}

          {/* Send a real test email so admins can confirm SMTP works without
              waiting for a storm. */}
          <Box sx={{ mt: 3, p: 2, borderRadius: 2, bgcolor: 'rgba(255,255,255,0.03)' }}>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>Send a test email</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
              Confirms SMTP credentials are working. The recipient will see a "Test Alert" message with no real lightning context.
            </Typography>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
              <TextField
                size="small"
                label="Send to"
                type="email"
                value={testEmailTo}
                onChange={e => setTestEmailTo(e.target.value)}
                placeholder="you@example.com"
                sx={{ minWidth: 260 }}
              />
              <Button
                variant="outlined"
                startIcon={<SendIcon />}
                onClick={handleSendTestEmail}
                disabled={testEmailSending || !testEmailTo.trim()}
              >
                {testEmailSending ? 'Sending…' : 'Send test email'}
              </Button>
            </Box>
          </Box>

          <Box sx={{ mt: 2, display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="contained" startIcon={<SaveIcon />} onClick={handleSaveNotifications} disabled={settingsSaving}>
              {settingsSaving ? 'Saving…' : 'Save Notifications'}
            </Button>
          </Box>
        </AccordionDetails>
      </Accordion>}

      {/* User Management — admin only — link out to the real users page.
          super_admin manages users per-org under /orgs, so we point them there
          rather than to the flat /users list (which would ignore org scope). */}
      {isAdmin && (
        <Card sx={{ mb: 2, bgcolor: 'background.paper' }}>
          <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 2, '&:last-child': { pb: 2 } }}>
            <SecurityIcon sx={{ color: 'primary.main' }} />
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="h6" sx={{ fontSize: 16 }}>Users &amp; Roles</Typography>
              <Typography variant="body2" color="text.secondary">
                {isSuperAdmin
                  ? 'Manage users per organisation from the Organisations page.'
                  : 'Manage users, roles and password resets on the dedicated Users page.'}
              </Typography>
            </Box>
            <Button component={RouterLink} to={isSuperAdmin ? '/orgs' : '/users'} variant="outlined" size="small">
              {isSuperAdmin ? 'Open Organisations' : 'Open Users'}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Data Retention — admin only, currently read-only reference values */}
      {isAdmin && <Accordion sx={{ mb: 2, bgcolor: 'background.paper', '&:before': { display: 'none' } }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <StorageIcon sx={{ color: 'primary.main' }} />
            <Typography variant="h6" sx={{ fontSize: 16 }}>Data Retention</Typography>
            <Chip icon={<LockIcon />} label="Reference only" size="small" variant="outlined" sx={{ fontSize: 11 }} />
          </Box>
        </AccordionSummary>
        <AccordionDetails>
          <Alert severity="info" sx={{ mb: 2 }}>
            These are the platform-wide retention defaults applied by the cleanup job. A future release will let admins edit these from this page.
          </Alert>
          <Grid container spacing={2}>
            <Grid item xs={6} sm={3}>
              <TextField fullWidth label="Flash Events (days)" type="number" size="small"
                value={dataRetention.flashRetentionDays} disabled />
            </Grid>
            <Grid item xs={6} sm={3}>
              <TextField fullWidth label="Risk States (days)" type="number" size="small"
                value={dataRetention.stateRetentionDays} disabled />
            </Grid>
            <Grid item xs={6} sm={3}>
              <TextField fullWidth label="Alerts (days)" type="number" size="small"
                value={dataRetention.alertRetentionDays} disabled />
            </Grid>
            <Grid item xs={6} sm={3}>
              <TextField fullWidth label="Ingestion Logs (days)" type="number" size="small"
                value={dataRetention.logRetentionDays} disabled />
            </Grid>
          </Grid>
          {health?.mode === 'in-memory-mock' && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              In-memory mock mode — all data is lost on server restart. Data retention policies only apply in production with PostgreSQL.
            </Alert>
          )}
        </AccordionDetails>
      </Accordion>}
    </Box>
  );
}

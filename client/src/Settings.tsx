import React, { useState, useEffect } from 'react';
import {
  Box, Card, CardContent, Typography, Grid, TextField, Button, Switch,
  FormControlLabel, Divider, Chip, Alert, Snackbar, Paper, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, IconButton, Tooltip,
  Accordion, AccordionSummary, AccordionDetails, Avatar, LinearProgress,
  useMediaQuery, useTheme,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import SaveIcon from '@mui/icons-material/Save';
import TuneIcon from '@mui/icons-material/Tune';
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive';
import SecurityIcon from '@mui/icons-material/Security';
import StorageIcon from '@mui/icons-material/Storage';
import SpeedIcon from '@mui/icons-material/Speed';
import PersonIcon from '@mui/icons-material/Person';
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import VisibilityIcon from '@mui/icons-material/Visibility';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { getHealth, getSettings, saveSettings } from './api';
import { useCurrentUser } from './App';

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

const ROLE_CONFIG: Record<string, { color: string; icon: React.ReactElement; desc: string }> = {
  admin: { color: '#d32f2f', icon: <AdminPanelSettingsIcon />, desc: 'Full access: manage locations, users, settings' },
  operator: { color: '#ed6c02', icon: <SecurityIcon />, desc: 'Acknowledge alerts, view all data' },
  viewer: { color: '#2e7d32', icon: <VisibilityIcon />, desc: 'Read-only access to dashboard and history' },
};

export default function Settings() {
  const currentUser = useCurrentUser();
  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'super_admin';

  const [health, setHealth] = useState<any>(null);
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'info' | 'error' }>({
    open: false, message: '', severity: 'success',
  });
  const [settingsSaving, setSettingsSaving] = useState(false);

  const [thresholds, setThresholds] = useState<GlobalThresholds>({
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
  });

  const [notifications, setNotifications] = useState<NotificationSettings>({
    emailEnabled: true,
    smsEnabled: false,
    escalationEnabled: true,
    escalationDelayMin: 5,
    smtpHost: 'smtp.gmail.com',
    alertFromAddress: 'alerts@flashaware.io',
  });

  const [dataRetention, setDataRetention] = useState({
    flashRetentionDays: 90,
    stateRetentionDays: 365,
    alertRetentionDays: 365,
    logRetentionDays: 30,
  });

  useEffect(() => {
    getHealth().then(res => setHealth(res.data)).catch(console.error);
    if (isAdmin) {
      getSettings().then(res => {
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
  }, [isAdmin]);

  const handleSaveThresholds = () => {
    setSnackbar({ open: true, message: 'Global thresholds saved (in-memory mock — will reset on server restart)', severity: 'success' });
  };

  const handleSaveNotifications = async () => {
    setSettingsSaving(true);
    try {
      await saveSettings({
        email_enabled:        String(notifications.emailEnabled),
        sms_enabled:          String(notifications.smsEnabled),
        escalation_enabled:   String(notifications.escalationEnabled),
        escalation_delay_min: String(notifications.escalationDelayMin),
        alert_from_address:   notifications.alertFromAddress,
      });
      setSnackbar({ open: true, message: 'Notification settings saved', severity: 'success' });
    } catch (err: any) {
      setSnackbar({ open: true, message: err.response?.data?.error || 'Failed to save settings', severity: 'error' });
    } finally {
      setSettingsSaving(false);
    }
  };

  const users = [
    { email: 'admin@lightning.local', name: 'Admin', role: 'admin', active: true },
    { email: 'operator@lightning.local', name: 'Operator', role: 'operator', active: true },
    { email: 'viewer@lightning.local', name: 'Viewer', role: 'viewer', active: true },
  ];

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

      {/* Global Thresholds — admin only */}
      {isAdmin && <Accordion defaultExpanded sx={{ mb: 2, bgcolor: 'background.paper', '&:before': { display: 'none' } }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <TuneIcon sx={{ color: 'primary.main' }} />
            <Typography variant="h6" sx={{ fontSize: 16 }}>Default Risk Thresholds</Typography>
          </Box>
        </AccordionSummary>
        <AccordionDetails>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            These defaults apply to newly created locations. Existing locations retain their individual thresholds.
          </Typography>
          <Grid container spacing={2}>
            <Grid item xs={6} sm={4} md={3}>
              <TextField fullWidth label="STOP Radius (km)" type="number" size="small"
                value={thresholds.defaultStopRadiusKm}
                onChange={e => setThresholds({ ...thresholds, defaultStopRadiusKm: +e.target.value })}
                helperText="Inner danger zone" />
            </Grid>
            <Grid item xs={6} sm={4} md={3}>
              <TextField fullWidth label="PREPARE Radius (km)" type="number" size="small"
                value={thresholds.defaultPrepareRadiusKm}
                onChange={e => setThresholds({ ...thresholds, defaultPrepareRadiusKm: +e.target.value })}
                helperText="Outer awareness zone" />
            </Grid>
            <Grid item xs={6} sm={4} md={3}>
              <TextField fullWidth label="STOP Flash Threshold" type="number" size="small"
                value={thresholds.defaultStopFlashThreshold}
                onChange={e => setThresholds({ ...thresholds, defaultStopFlashThreshold: +e.target.value })}
                helperText="Flashes to trigger STOP" />
            </Grid>
            <Grid item xs={6} sm={4} md={3}>
              <TextField fullWidth label="STOP Window (min)" type="number" size="small"
                value={thresholds.defaultStopWindowMin}
                onChange={e => setThresholds({ ...thresholds, defaultStopWindowMin: +e.target.value })}
                helperText="Time window for STOP" />
            </Grid>
            <Grid item xs={6} sm={4} md={3}>
              <TextField fullWidth label="PREPARE Flash Threshold" type="number" size="small"
                value={thresholds.defaultPrepareFlashThreshold}
                onChange={e => setThresholds({ ...thresholds, defaultPrepareFlashThreshold: +e.target.value })}
                helperText="Flashes to trigger PREPARE" />
            </Grid>
            <Grid item xs={6} sm={4} md={3}>
              <TextField fullWidth label="PREPARE Window (min)" type="number" size="small"
                value={thresholds.defaultPrepareWindowMin}
                onChange={e => setThresholds({ ...thresholds, defaultPrepareWindowMin: +e.target.value })}
                helperText="Time window for PREPARE" />
            </Grid>
            <Grid item xs={6} sm={4} md={3}>
              <TextField fullWidth label="ALL CLEAR Wait (min)" type="number" size="small"
                value={thresholds.defaultAllclearWaitMin}
                onChange={e => setThresholds({ ...thresholds, defaultAllclearWaitMin: +e.target.value })}
                helperText="Min wait before ALL CLEAR" />
            </Grid>
            <Grid item xs={6} sm={4} md={3}>
              <TextField fullWidth label="Stale Data Threshold (min)" type="number" size="small"
                value={thresholds.staleDataThresholdMin}
                onChange={e => setThresholds({ ...thresholds, staleDataThresholdMin: +e.target.value })}
                helperText="Max data age before DEGRADED" />
            </Grid>
            <Grid item xs={6} sm={4} md={3}>
              <TextField fullWidth label="Min Flash Confidence" type="number" size="small"
                value={thresholds.flashConfidenceMin} inputProps={{ step: 0.1, min: 0, max: 1 }}
                onChange={e => setThresholds({ ...thresholds, flashConfidenceMin: +e.target.value })}
                helperText="Filter confidence ≥ this" />
            </Grid>
            <Grid item xs={6} sm={4} md={3}>
              <TextField fullWidth label="Max Flash Duration (ms)" type="number" size="small"
                value={thresholds.flashDurationMaxMs}
                onChange={e => setThresholds({ ...thresholds, flashDurationMaxMs: +e.target.value })}
                helperText="P95 duration clamp" />
            </Grid>
          </Grid>
          <Box sx={{ mt: 2, display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="contained" startIcon={<SaveIcon />} onClick={handleSaveThresholds}>
              Save Thresholds
            </Button>
          </Box>
        </AccordionDetails>
      </Accordion>}

      {/* Notifications — admin only */}
      {isAdmin && <Accordion sx={{ mb: 2, bgcolor: 'background.paper', '&:before': { display: 'none' } }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <NotificationsActiveIcon sx={{ color: 'primary.main' }} />
            <Typography variant="h6" sx={{ fontSize: 16 }}>Notification Settings</Typography>
          </Box>
        </AccordionSummary>
        <AccordionDetails>
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
                onChange={e => setNotifications({ ...notifications, escalationDelayMin: +e.target.value })}
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
          <Box sx={{ mt: 2, display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="contained" startIcon={<SaveIcon />} onClick={handleSaveNotifications} disabled={settingsSaving}>
              {settingsSaving ? 'Saving…' : 'Save Notifications'}
            </Button>
          </Box>
        </AccordionDetails>
      </Accordion>}

      {/* User Management — admin only */}
      {isAdmin && <Accordion sx={{ mb: 2, bgcolor: 'background.paper', '&:before': { display: 'none' } }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <SecurityIcon sx={{ color: 'primary.main' }} />
            <Typography variant="h6" sx={{ fontSize: 16 }}>Users &amp; Roles</Typography>
            <Chip label={`${users.length} users`} size="small" variant="outlined" />
          </Box>
        </AccordionSummary>
        <AccordionDetails>
          <TableContainer sx={{ overflowX: 'auto' }}>
            <Table size="small" sx={{ minWidth: 600 }}>
              <TableHead>
                <TableRow>
                  <TableCell>User</TableCell>
                  <TableCell>Role</TableCell>
                  <TableCell>Permissions</TableCell>
                  <TableCell>Status</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {users.map(u => {
                  const rcfg = ROLE_CONFIG[u.role] || ROLE_CONFIG.viewer;
                  return (
                    <TableRow key={u.email} hover>
                      <TableCell>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                          <Avatar sx={{ width: 32, height: 32, bgcolor: rcfg.color, fontSize: 14 }}>
                            {u.name.charAt(0)}
                          </Avatar>
                          <Box>
                            <Typography variant="body2" fontWeight={500}>{u.name}</Typography>
                            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 12 }}>{u.email}</Typography>
                          </Box>
                        </Box>
                      </TableCell>
                      <TableCell>
                        <Chip icon={rcfg.icon} label={u.role.toUpperCase()} size="small"
                          sx={{ bgcolor: `${rcfg.color}20`, color: rcfg.color, fontWeight: 600, fontSize: 11,
                            '& .MuiChip-icon': { color: rcfg.color, fontSize: 16 } }} />
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" color="text.secondary" sx={{ fontSize: 12 }}>
                          {rcfg.desc}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Chip icon={<CheckCircleIcon />} label="Active" size="small" color="success"
                          sx={{ fontWeight: 600, fontSize: 11 }} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
          <Alert severity="info" sx={{ mt: 2 }}>
            User management is available in production mode with PostgreSQL. In mock mode, three demo users are pre-configured.
            <br /><strong>Credentials:</strong> All users use password <code>admin123</code>
          </Alert>
        </AccordionDetails>
      </Accordion>}

      {/* Data Retention — admin only */}
      {isAdmin && <Accordion sx={{ mb: 2, bgcolor: 'background.paper', '&:before': { display: 'none' } }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <StorageIcon sx={{ color: 'primary.main' }} />
            <Typography variant="h6" sx={{ fontSize: 16 }}>Data Retention</Typography>
          </Box>
        </AccordionSummary>
        <AccordionDetails>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Configure how long historical data is retained before automatic cleanup.
          </Typography>
          <Grid container spacing={2}>
            <Grid item xs={6} sm={3}>
              <TextField fullWidth label="Flash Events (days)" type="number" size="small"
                value={dataRetention.flashRetentionDays}
                onChange={e => setDataRetention({ ...dataRetention, flashRetentionDays: +e.target.value })} />
            </Grid>
            <Grid item xs={6} sm={3}>
              <TextField fullWidth label="Risk States (days)" type="number" size="small"
                value={dataRetention.stateRetentionDays}
                onChange={e => setDataRetention({ ...dataRetention, stateRetentionDays: +e.target.value })} />
            </Grid>
            <Grid item xs={6} sm={3}>
              <TextField fullWidth label="Alerts (days)" type="number" size="small"
                value={dataRetention.alertRetentionDays}
                onChange={e => setDataRetention({ ...dataRetention, alertRetentionDays: +e.target.value })} />
            </Grid>
            <Grid item xs={6} sm={3}>
              <TextField fullWidth label="Ingestion Logs (days)" type="number" size="small"
                value={dataRetention.logRetentionDays}
                onChange={e => setDataRetention({ ...dataRetention, logRetentionDays: +e.target.value })} />
            </Grid>
          </Grid>
          {health?.mode === 'in-memory-mock' && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              In-memory mock mode — all data is lost on server restart. Data retention policies only apply in production with PostgreSQL.
            </Alert>
          )}
          <Box sx={{ mt: 2, display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="contained" startIcon={<SaveIcon />} onClick={() =>
              setSnackbar({ open: true, message: 'Retention policy saved', severity: 'success' })}>
              Save Retention Policy
            </Button>
          </Box>
        </AccordionDetails>
      </Accordion>}

      <Snackbar open={snackbar.open} autoHideDuration={4000}
        onClose={() => setSnackbar({ ...snackbar, open: false })}>
        <Alert severity={snackbar.severity} variant="filled">{snackbar.message}</Alert>
      </Snackbar>
    </Box>
  );
}

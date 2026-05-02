import React, { useState } from 'react';
import {
  Box, Grid, Typography, Chip, Alert, Divider, TextField, Button, Switch,
  FormControlLabel, Tooltip, IconButton, CircularProgress, Paper,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import EmailIcon from '@mui/icons-material/Email';
import SmsIcon from '@mui/icons-material/Sms';
import WhatsAppIcon from '@mui/icons-material/WhatsApp';
import VerifiedIcon from '@mui/icons-material/Verified';
import SendIcon from '@mui/icons-material/Send';
import { STATE_CONFIG } from '../states';
import InfoTip from './InfoTip';
import { helpBody, helpTitle } from '../help/copy';

const E164_RE = /^\+[1-9]\d{6,14}$/;

type NotifyStatesMap = Partial<Record<'STOP' | 'PREPARE' | 'HOLD' | 'ALL_CLEAR' | 'DEGRADED', boolean>>;

export interface RecipientRecord {
  id: number;
  location_id: string;
  email: string;
  phone: string | null;
  active: boolean;
  notify_email: boolean;
  notify_sms: boolean;
  notify_whatsapp: boolean;
  phone_verified_at: string | null;
  notify_states: NotifyStatesMap;
}

export interface NewRecipientInput {
  email: string;
  phone?: string;
  notify_email: boolean;
  notify_sms: boolean;
  notify_whatsapp: boolean;
}

// Matches the api.ts updateRecipient signature so callers can pass it
// through without massaging types. `phone` accepts undefined (omit) only —
// phone clearing isn't surfaced through this component.
export interface RecipientUpdate {
  email?: string;
  phone?: string;
  active?: boolean;
  notify_email?: boolean;
  notify_sms?: boolean;
  notify_whatsapp?: boolean;
  notify_states?: NotifyStatesMap;
}

interface Props {
  // null = "creating a new location" mode → shows pendingEmails buffer
  // string = "editing an existing location" → talks to the API
  editing: string | null;
  recipients: RecipientRecord[];
  recipientsLoading: boolean;
  pendingEmails: string[];
  testingRecipientId: number | null;

  // Intents — the parent wires these into the editor's existing handlers.
  onAddPersisted: (input: NewRecipientInput) => Promise<void>;
  onAddPending: (email: string) => void;
  onRemovePending: (email: string) => void;
  onUpdate: (recipient: RecipientRecord, patch: RecipientUpdate) => void;
  onDelete: (recipient: RecipientRecord) => void;
  onSendTest: (recipient: RecipientRecord) => void;
  onStartVerify: (recipient: RecipientRecord) => void;
}

// Notification recipients sub-panel for the location editor. Owns the
// "add new recipient" form-row state internally — the parent only sees the
// resulting onAddPersisted / onAddPending intents. The recipients table /
// card list is pure-render off `recipients`.
export function RecipientPanel({
  editing,
  recipients,
  recipientsLoading,
  pendingEmails,
  testingRecipientId,
  onAddPersisted, onAddPending, onRemovePending,
  onUpdate, onDelete, onSendTest, onStartVerify,
}: Props) {
  const [newEmail, setNewEmail] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newNotifyEmail, setNewNotifyEmail] = useState(true);
  const [newNotifySms, setNewNotifySms] = useState(false);
  const [newNotifyWhatsApp, setNewNotifyWhatsApp] = useState(false);
  const [adding, setAdding] = useState(false);

  const phoneInvalid = newPhone.length > 0 && !E164_RE.test(newPhone.trim());

  const handleAdd = async () => {
    const email = newEmail.trim();
    if (!email) return;
    if (!editing) {
      // Create mode: buffer locally, parent will persist on save.
      onAddPending(email.toLowerCase());
      setNewEmail('');
      return;
    }
    setAdding(true);
    try {
      await onAddPersisted({
        email,
        phone: newPhone.trim() || undefined,
        notify_email: newNotifyEmail,
        notify_sms: newNotifySms,
        notify_whatsapp: newNotifyWhatsApp,
      });
      setNewEmail('');
      setNewPhone('');
      setNewNotifyEmail(true);
      setNewNotifySms(false);
      setNewNotifyWhatsApp(false);
    } finally {
      setAdding(false);
    }
  };

  return (
    <>
      <Grid item xs={12}>
        <Divider sx={{ my: 1 }} />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
          <EmailIcon sx={{ color: 'primary.main', fontSize: 20 }} />
          <Typography variant="subtitle2">Notification Recipients</Typography>
          <InfoTip
            variant="dialog"
            title="How notifications work"
            body={
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                <Typography variant="body2">
                  Every recipient row holds an email and an optional phone number, plus three channel toggles (Email / SMS / WhatsApp) and a per-state subscription list.
                </Typography>
                <Typography variant="body2">
                  <strong>Two layers must both be ON for a message to send:</strong> the org-level channel switches (Settings → Notifications) AND this recipient's channel toggle. Either one off → no message on that channel.
                </Typography>
                <Typography variant="body2">
                  <strong>SMS and WhatsApp also require phone verification.</strong> Click <em>Verify</em> next to a phone number — the recipient gets a one-time 6-digit code, you enter it back, and the channel unlocks.
                </Typography>
                <Typography variant="body2">
                  <strong>Per-state subscription</strong> lets a recipient opt out of e.g. ALL CLEAR while still receiving STOP. Click each circular S / H / P / A / D pill to toggle that state.
                </Typography>
              </Box>
            }
          />
          {editing && (
            <Chip
              label={`${recipients.filter(r => r.active).length} active`}
              size="small" color="primary" variant="outlined" sx={{ fontSize: 11 }}
            />
          )}
          {!editing && pendingEmails.length > 0 && (
            <Chip
              label={`${pendingEmails.length} added`}
              size="small" color="primary" variant="outlined" sx={{ fontSize: 11 }}
            />
          )}
        </Box>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5, fontSize: 12 }}>
          Recipients receive alerts via email, SMS and/or WhatsApp when the location's risk state changes. Toggle email off per recipient to suppress email for that person.
        </Typography>
        {!editing && (
          <Alert severity="info" sx={{ mb: 1.5, fontSize: 12, py: 0.5 }}>
            Add email recipients now and they'll be created with the location. Phone numbers, SMS/WhatsApp toggles, and per-state opt-ins can be configured after the location is saved (phone numbers also require OTP verification).
          </Alert>
        )}
      </Grid>

      {/* Add new recipient row */}
      <Grid item xs={12}>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <TextField
            label="Email address" type="email" size="small"
            value={newEmail}
            onChange={e => setNewEmail(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
            sx={{ flex: '1 1 180px', minWidth: 160 }}
            placeholder="name@example.com"
          />
          <TextField
            label="Phone (E.164)" size="small"
            value={newPhone}
            onChange={e => setNewPhone(e.target.value)}
            sx={{ flex: '1 1 140px', minWidth: 130 }}
            placeholder="+27821234567"
            error={phoneInvalid}
            helperText={phoneInvalid ? 'Use E.164: +<country><number>' : ''}
            InputProps={{
              endAdornment: (
                <InfoTip inline title={helpTitle('phone_e164')} body={helpBody('phone_e164')} />
              ),
            }}
          />
          <Tooltip title="Send email alerts">
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', fontSize: 11, color: 'text.secondary' }}>
              <EmailIcon sx={{ fontSize: 18, color: newNotifyEmail ? 'primary.main' : 'text.disabled' }} />
              <Switch checked={newNotifyEmail} onChange={e => setNewNotifyEmail(e.target.checked)} size="small" color="primary" />
            </Box>
          </Tooltip>
          <Tooltip title="Send SMS alerts">
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', fontSize: 11, color: 'text.secondary' }}>
              <SmsIcon sx={{ fontSize: 18, color: newNotifySms ? 'primary.main' : 'text.disabled' }} />
              <Switch checked={newNotifySms} onChange={e => setNewNotifySms(e.target.checked)} size="small" />
            </Box>
          </Tooltip>
          <Tooltip title="Send WhatsApp alerts">
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', fontSize: 11, color: 'text.secondary' }}>
              <WhatsAppIcon sx={{ fontSize: 18, color: newNotifyWhatsApp ? 'success.main' : 'text.disabled' }} />
              <Switch checked={newNotifyWhatsApp} onChange={e => setNewNotifyWhatsApp(e.target.checked)} size="small" />
            </Box>
          </Tooltip>
          <Button
            variant="outlined"
            startIcon={adding ? <CircularProgress size={14} /> : <AddIcon />}
            onClick={handleAdd}
            disabled={!newEmail.trim() || adding}
            size="small"
            sx={{ height: 40, alignSelf: 'flex-start', mt: 0.5 }}
          >
            Add
          </Button>
        </Box>
      </Grid>

      {/* Recipients list */}
      <Grid item xs={12}>
        {editing ? (
          recipientsLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
              <CircularProgress size={24} />
            </Box>
          ) : recipients.length === 0 ? (
            <Alert severity="info" sx={{ fontSize: 12 }}>
              No recipients configured. Add an email address above to start receiving alert emails for this location.
            </Alert>
          ) : (
            <>
              {/* Mobile: card-per-recipient — the 8-column table is unusable under sm */}
              <Box sx={{ display: { xs: 'flex', sm: 'none' }, flexDirection: 'column', gap: 1 }}>
                {recipients.map(r => {
                  const phoneVerified = !!r.phone_verified_at;
                  return (
                    <Paper key={r.id} variant="outlined" sx={{ p: 1.5, bgcolor: 'rgba(255,255,255,0.02)' }}>
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 1, mb: 1 }}>
                        <Box sx={{ minWidth: 0 }}>
                          <Typography variant="body2" fontWeight={600} sx={{ wordBreak: 'break-all' }}>{r.email}</Typography>
                          {r.phone && (
                            <Typography variant="caption" color="text.secondary" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                              {r.phone}
                              {phoneVerified
                                ? <VerifiedIcon sx={{ fontSize: 12, color: 'success.main' }} />
                                : <Button size="small" sx={{ fontSize: 10, py: 0, px: 0.5, minWidth: 0 }} onClick={() => onStartVerify(r)}>Verify</Button>}
                            </Typography>
                          )}
                        </Box>
                        <Switch checked={r.active} size="small"
                          onChange={() => onUpdate(r, { active: !r.active })} />
                      </Box>
                      <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', mb: 1 }}>
                        <FormControlLabel
                          control={<Switch size="small" checked={r.notify_email !== false}
                            onChange={() => onUpdate(r, { notify_email: r.notify_email === false })} />}
                          label={<Typography sx={{ fontSize: 11 }}>Email</Typography>}
                        />
                        <FormControlLabel
                          control={<Switch size="small" checked={!!r.notify_sms && phoneVerified}
                            disabled={!r.phone || !phoneVerified}
                            onChange={() => onUpdate(r, { notify_sms: !r.notify_sms })} />}
                          label={<Typography sx={{ fontSize: 11 }}>SMS</Typography>}
                        />
                        <FormControlLabel
                          control={<Switch size="small" color="success" checked={!!r.notify_whatsapp && phoneVerified}
                            disabled={!r.phone || !phoneVerified}
                            onChange={() => onUpdate(r, { notify_whatsapp: !r.notify_whatsapp })} />}
                          label={<Typography sx={{ fontSize: 11 }}>WhatsApp</Typography>}
                        />
                      </Box>
                      <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 1 }}>
                        {(['STOP', 'HOLD', 'PREPARE', 'ALL_CLEAR', 'DEGRADED'] as const).map(s => {
                          const cfg = STATE_CONFIG[s];
                          const subscribed = r.notify_states?.[s] !== false;
                          const toggle = () => {
                            const next: NotifyStatesMap = { ...(r.notify_states ?? {}), [s]: !subscribed };
                            onUpdate(r, { notify_states: next });
                          };
                          return (
                            <Chip key={s}
                              size="small"
                              label={cfg.label}
                              onClick={toggle}
                              aria-pressed={subscribed}
                              aria-label={`${subscribed ? 'Unsubscribe from' : 'Subscribe to'} ${cfg.label} alerts for ${r.email}`}
                              sx={{
                                bgcolor: subscribed ? cfg.color : 'transparent',
                                color: subscribed ? cfg.textColor : cfg.color,
                                border: `1px solid ${cfg.color}`,
                                fontSize: 10, height: 22, cursor: 'pointer',
                                opacity: subscribed ? 1 : 0.6,
                              }}
                            />
                          );
                        })}
                      </Box>
                      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 0.5 }}>
                        <Button
                          size="small" variant="outlined"
                          startIcon={testingRecipientId === r.id ? <CircularProgress size={12} /> : <SendIcon sx={{ fontSize: 14 }} />}
                          onClick={() => onSendTest(r)}
                          disabled={!r.active || testingRecipientId === r.id}
                          sx={{ fontSize: 11 }}
                        >
                          Send test
                        </Button>
                        <IconButton aria-label="Delete recipient" size="small" color="error" onClick={() => onDelete(r)}>
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Box>
                    </Paper>
                  );
                })}
              </Box>

              {/* Desktop / tablet: full table */}
              <TableContainer component={Paper} variant="outlined" sx={{ bgcolor: 'rgba(255,255,255,0.02)', display: { xs: 'none', sm: 'block' } }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ fontSize: 11 }}>Email</TableCell>
                      <TableCell sx={{ fontSize: 11 }}>Phone</TableCell>
                      <TableCell sx={{ fontSize: 11 }} align="center"><Tooltip title="Email"><EmailIcon sx={{ fontSize: 14 }} /></Tooltip></TableCell>
                      <TableCell sx={{ fontSize: 11 }} align="center"><Tooltip title="SMS"><SmsIcon sx={{ fontSize: 14 }} /></Tooltip></TableCell>
                      <TableCell sx={{ fontSize: 11 }} align="center"><Tooltip title="WhatsApp"><WhatsAppIcon sx={{ fontSize: 14 }} /></Tooltip></TableCell>
                      <TableCell sx={{ fontSize: 11 }} align="center">
                        <Box sx={{ display: 'inline-flex', alignItems: 'center' }}>
                          <span>States</span>
                          <InfoTip
                            inline
                            title="Per-state subscription"
                            body={
                              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                                <Typography variant="body2">Each circular pill toggles whether this recipient is alerted for that state. Click to flip on/off.</Typography>
                                <Box sx={{ mt: 0.5 }}>
                                  <Typography variant="body2"><strong>S</strong> = STOP</Typography>
                                  <Typography variant="body2"><strong>H</strong> = HOLD</Typography>
                                  <Typography variant="body2"><strong>P</strong> = PREPARE</Typography>
                                  <Typography variant="body2"><strong>A</strong> = ALL CLEAR</Typography>
                                  <Typography variant="body2"><strong>D</strong> = NO DATA FEED (DEGRADED)</Typography>
                                </Box>
                              </Box>
                            }
                          />
                        </Box>
                      </TableCell>
                      <TableCell sx={{ fontSize: 11 }}>
                        <Box sx={{ display: 'inline-flex', alignItems: 'center' }}>
                          <span>Receive&nbsp;alerts</span>
                          <InfoTip inline title={helpTitle('receive_alerts')} body={helpBody('receive_alerts')} />
                        </Box>
                      </TableCell>
                      <TableCell sx={{ fontSize: 11, width: 96 }} align="center">Actions</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {recipients.map(r => {
                      const phoneVerified = !!r.phone_verified_at;
                      const smsTooltip = !r.phone
                        ? 'Add a phone number first'
                        : !phoneVerified
                          ? 'Verify the phone number to enable SMS'
                          : (r.notify_sms ? 'SMS on — click to disable' : 'SMS off — click to enable');
                      const waTooltip = !r.phone
                        ? 'Add a phone number first'
                        : !phoneVerified
                          ? 'Verify the phone number to enable WhatsApp'
                          : (r.notify_whatsapp ? 'WhatsApp on — click to disable' : 'WhatsApp off — click to enable');
                      return (
                        <TableRow key={r.id} hover>
                          <TableCell sx={{ fontSize: 12 }}>{r.email}</TableCell>
                          <TableCell sx={{ fontSize: 12, color: 'text.secondary' }}>
                            {r.phone ? (
                              <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                                <span>{r.phone}</span>
                                {phoneVerified ? (
                                  <Tooltip title={`Verified ${new Date(r.phone_verified_at!).toLocaleString()}`}>
                                    <VerifiedIcon sx={{ fontSize: 14, color: 'success.main' }} />
                                  </Tooltip>
                                ) : (
                                  <Button
                                    size="small" variant="text"
                                    onClick={() => onStartVerify(r)}
                                    sx={{ fontSize: 10, py: 0, px: 0.5, minWidth: 0 }}
                                  >
                                    Verify
                                  </Button>
                                )}
                              </Box>
                            ) : '—'}
                          </TableCell>
                          <TableCell align="center">
                            <Tooltip title={r.notify_email !== false ? 'Email on — click to disable' : 'Email off — click to enable'}>
                              <Switch
                                checked={r.notify_email !== false}
                                onChange={() => onUpdate(r, { notify_email: r.notify_email === false })}
                                size="small" color="primary"
                              />
                            </Tooltip>
                          </TableCell>
                          <TableCell align="center">
                            <Tooltip title={smsTooltip}>
                              <span>
                                <Switch
                                  checked={!!r.notify_sms && phoneVerified}
                                  onChange={() => onUpdate(r, { notify_sms: !r.notify_sms })}
                                  size="small"
                                  disabled={!r.phone || !phoneVerified}
                                />
                              </span>
                            </Tooltip>
                          </TableCell>
                          <TableCell align="center">
                            <Tooltip title={waTooltip}>
                              <span>
                                <Switch
                                  checked={!!r.notify_whatsapp && phoneVerified}
                                  onChange={() => onUpdate(r, { notify_whatsapp: !r.notify_whatsapp })}
                                  size="small"
                                  disabled={!r.phone || !phoneVerified}
                                  color="success"
                                />
                              </span>
                            </Tooltip>
                          </TableCell>
                          <TableCell align="center" sx={{ whiteSpace: 'nowrap' }}>
                            {(['STOP', 'HOLD', 'PREPARE', 'ALL_CLEAR', 'DEGRADED'] as const).map(s => {
                              const cfg = STATE_CONFIG[s];
                              // Missing key === subscribed (server fail-safe). Explicit false === opted out.
                              const subscribed = r.notify_states?.[s] !== false;
                              const toggle = () => {
                                const next: NotifyStatesMap = { ...(r.notify_states ?? {}), [s]: !subscribed };
                                onUpdate(r, { notify_states: next });
                              };
                              return (
                                <Tooltip key={s} title={`${cfg.label} alerts: ${subscribed ? 'on' : 'off'} — click to toggle`}>
                                  <Box
                                    onClick={toggle}
                                    onKeyDown={(e) => {
                                      // role="button" requires Space and Enter to activate (WAI-ARIA).
                                      if (e.key === ' ' || e.key === 'Enter') {
                                        e.preventDefault();
                                        toggle();
                                      }
                                    }}
                                    sx={{
                                      display: 'inline-flex',
                                      alignItems: 'center', justifyContent: 'center',
                                      width: 22, height: 22, mx: 0.25,
                                      borderRadius: '50%',
                                      bgcolor: subscribed ? cfg.color : 'transparent',
                                      border: subscribed ? 'none' : `1px solid ${cfg.color}`,
                                      cursor: 'pointer',
                                      opacity: subscribed ? 1 : 0.55,
                                      verticalAlign: 'middle',
                                      color: subscribed ? cfg.textColor : cfg.color,
                                      fontSize: 10, fontWeight: 700,
                                      transition: 'opacity 0.15s, background-color 0.15s',
                                      '&:hover': { opacity: 1 },
                                      '&:focus-visible': { outline: '2px solid #fff', outlineOffset: 2 },
                                    }}
                                    role="button"
                                    tabIndex={0}
                                    aria-pressed={subscribed}
                                    aria-label={`${subscribed ? 'Unsubscribe from' : 'Subscribe to'} ${cfg.label} alerts for ${r.email}`}
                                  >
                                    {s === 'ALL_CLEAR' ? 'A' : s === 'DEGRADED' ? 'D' : s[0]}
                                  </Box>
                                </Tooltip>
                              );
                            })}
                          </TableCell>
                          <TableCell>
                            <Tooltip title={r.active ? 'Receive alerts is ON — click to suppress all alerts to this recipient' : 'Receive alerts is OFF — click to resume sending alerts to this recipient'}>
                              <Switch
                                checked={r.active}
                                onChange={() => onUpdate(r, { active: !r.active })}
                                size="small"
                              />
                            </Tooltip>
                          </TableCell>
                          <TableCell sx={{ whiteSpace: 'nowrap' }}>
                            <Tooltip title="Send a test message via every channel this recipient has on">
                              <span>
                                <IconButton
                                  aria-label="Send test"
                                  size="small" color="primary"
                                  onClick={() => onSendTest(r)}
                                  disabled={!r.active || testingRecipientId === r.id}
                                >
                                  {testingRecipientId === r.id ? <CircularProgress size={14} /> : <SendIcon fontSize="small" />}
                                </IconButton>
                              </span>
                            </Tooltip>
                            <Tooltip title="Remove recipient">
                              <IconButton
                                aria-label="Delete"
                                size="small" color="error"
                                onClick={() => onDelete(r)}
                              >
                                <DeleteIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
            </>
          )
        ) : pendingEmails.length > 0 ? (
          <TableContainer component={Paper} variant="outlined" sx={{ bgcolor: 'rgba(255,255,255,0.02)' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontSize: 11 }}>Email</TableCell>
                  <TableCell sx={{ fontSize: 11, width: 48 }} />
                </TableRow>
              </TableHead>
              <TableBody>
                {pendingEmails.map(email => (
                  <TableRow key={email} hover>
                    <TableCell sx={{ fontSize: 12 }}>{email}</TableCell>
                    <TableCell>
                      <Tooltip title="Remove">
                        <IconButton
                          aria-label="Delete" size="small" color="error"
                          onClick={() => onRemovePending(email)}
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        ) : null}
      </Grid>
    </>
  );
}

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Box, Card, CardContent, Typography, Grid, Button, TextField, Select,
  MenuItem, FormControl, InputLabel, Switch, FormControlLabel, Slider,
  Dialog, DialogTitle, DialogContent, DialogActions, Chip, IconButton,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper,
  Alert, Snackbar, useMediaQuery, useTheme, Divider, Tooltip, CircularProgress,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import EmailIcon from '@mui/icons-material/Email';
import LocationOnIcon from '@mui/icons-material/LocationOn';
import SearchIcon from '@mui/icons-material/Search';
import SmsIcon from '@mui/icons-material/Sms';
import WhatsAppIcon from '@mui/icons-material/WhatsApp';
import VerifiedIcon from '@mui/icons-material/Verified';
import InputAdornment from '@mui/material/InputAdornment';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import { MapContainer, TileLayer, Polygon, CircleMarker, Popup, useMapEvents, useMap } from 'react-leaflet';
import { DateTime } from 'luxon';
import { getLocations, createLocation, updateLocation, deleteLocation, getRecipients, addRecipient, updateRecipient, deleteRecipient, sendRecipientOtp, verifyRecipientOtp } from './api';
import { useCurrentUser } from './App';
import { useOrgScope } from './OrgScope';
import { STATE_CONFIG, stateOf } from './states';
import type { LatLngExpression } from 'leaflet';

const MAX_VERIFY_ATTEMPTS = 5;
function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

const SITE_TYPES = [
  { value: 'mine', label: 'Mine' },
  { value: 'golf_course', label: 'Golf Course' },
  { value: 'construction', label: 'Construction Site' },
  { value: 'event', label: 'Event Venue' },
  { value: 'wind_farm', label: 'Wind Farm' },
  { value: 'other', label: 'Other' },
];

interface LocationData {
  id: string;
  name: string;
  site_type: string;
  geojson: any;
  lng: number;
  lat: number;
  current_state: string | null;
  stop_radius_km: number;
  prepare_radius_km: number;
  stop_flash_threshold: number;
  stop_window_min: number;
  prepare_flash_threshold: number;
  prepare_window_min: number;
  allclear_wait_min: number;
  persistence_alert_min: number;
  alert_on_change_only: boolean;
  enabled: boolean;
  // Populated for super_admin's cross-org view; omitted for normal users.
  org_id?: string;
  org_name?: string | null;
  org_slug?: string | null;
}

interface FormState {
  name: string;
  site_type: string;
  lat: number;
  lng: number;
  stop_radius_km: number;
  prepare_radius_km: number;
  stop_flash_threshold: number;
  stop_window_min: number;
  prepare_flash_threshold: number;
  prepare_window_min: number;
  allclear_wait_min: number;
  persistence_alert_min: number;
  alert_on_change_only: boolean;
}

const defaultForm: FormState = {
  name: '', site_type: 'mine', lat: -26.2041, lng: 28.0473,
  stop_radius_km: 10, prepare_radius_km: 20, stop_flash_threshold: 1,
  stop_window_min: 15, prepare_flash_threshold: 1, prepare_window_min: 15,
  allclear_wait_min: 30, persistence_alert_min: 10, alert_on_change_only: false,
};

interface RecipientRecord {
  id: number;
  location_id: string;
  email: string;
  phone: string | null;
  active: boolean;
  notify_email: boolean;
  notify_sms: boolean;
  notify_whatsapp: boolean;
  phone_verified_at: string | null;
}

// Nominatim result type
interface NominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
}

// Geocoding search box using OpenStreetMap Nominatim (free, no API key)
function GeoSearchBox({ onSelect }: { onSelect: (lat: number, lng: number, label: string) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<NominatimResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 3) { setResults([]); setOpen(false); return; }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          format: 'json',
          q: query,
          limit: '6',
          countrycodes: 'za',
          viewbox: '16.3,-34.9,32.9,-22.1',
          bounded: '0',
        });
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?${params}`,
          { headers: { 'Accept-Language': 'en' } }
        );
        const data: NominatimResult[] = await res.json();
        setResults(data);
        setOpen(data.length > 0);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 350);
  }, [query]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleSelect = (r: NominatimResult) => {
    onSelect(parseFloat(r.lat), parseFloat(r.lon), r.display_name);
    setQuery(r.display_name.split(',').slice(0, 2).join(','));
    setOpen(false);
    setResults([]);
  };

  return (
    <Box ref={containerRef} sx={{ position: 'relative' }}>
      <TextField
        fullWidth
        size="small"
        label="Search for a place"
        placeholder="e.g. Rustenburg, Sun City, Sandton..."
        value={query}
        onChange={e => setQuery(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              {loading ? <CircularProgress size={16} /> : <SearchIcon fontSize="small" sx={{ color: 'text.secondary' }} />}
            </InputAdornment>
          ),
        }}
      />
      {open && results.length > 0 && (
        <Paper
          elevation={8}
          sx={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            zIndex: 9999,
            maxHeight: 240,
            overflowY: 'auto',
            mt: 0.5,
            border: '1px solid rgba(255,255,255,0.12)',
          }}
        >
          <List dense disablePadding>
            {results.map(r => (
              <ListItemButton
                key={r.place_id}
                onClick={() => handleSelect(r)}
                sx={{ borderBottom: '1px solid rgba(255,255,255,0.06)', '&:last-child': { borderBottom: 'none' } }}
              >
                <LocationOnIcon sx={{ fontSize: 16, color: 'primary.main', mr: 1, flexShrink: 0 }} />
                <ListItemText
                  primary={r.display_name.split(',').slice(0, 2).join(',')}
                  secondary={r.display_name.split(',').slice(2, 4).join(',').trim() || undefined}
                  primaryTypographyProps={{ fontSize: 13 }}
                  secondaryTypographyProps={{ fontSize: 11 }}
                />
              </ListItemButton>
            ))}
          </List>
        </Paper>
      )}
    </Box>
  );
}

// Pans the map when lat/lng changes
function MapFlyTo({ lat, lng }: { lat: number; lng: number }) {
  const map = useMap();
  useEffect(() => { map.flyTo([lat, lng], map.getZoom(), { duration: 0.8 }); }, [lat, lng]);
  return null;
}

// Click-to-set-centroid map component
function CentroidPicker({ lat, lng, onChange }: { lat: number; lng: number; onChange: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onChange(e.latlng.lat, e.latlng.lng);
    },
  });
  return (
    <CircleMarker center={[lat, lng]} radius={8} pathOptions={{ color: '#fbc02d', fillColor: '#fbc02d', fillOpacity: 0.9 }}>
      <Popup>Site centroid: {lat.toFixed(4)}, {lng.toFixed(4)}</Popup>
    </CircleMarker>
  );
}

export default function LocationEditor() {
  const currentUser = useCurrentUser();
  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'super_admin';
  const isSuperAdmin = currentUser?.role === 'super_admin';
  const { scopedOrgId, scopedOrgName } = useOrgScope();

  const [locations, setLocations] = useState<LocationData[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(defaultForm);
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false, message: '', severity: 'success',
  });

  // Recipient management state
  const [recipients, setRecipients] = useState<RecipientRecord[]>([]);
  const [recipientsLoading, setRecipientsLoading] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newNotifyEmail, setNewNotifyEmail] = useState(true);
  const [newNotifySms, setNewNotifySms] = useState(false);
  const [newNotifyWhatsApp, setNewNotifyWhatsApp] = useState(false);
  const [addingRecipient, setAddingRecipient] = useState(false);
  const [pendingEmails, setPendingEmails] = useState<string[]>([]);
  const [deleteConfirm, setDeleteConfirm] = useState<LocationData | null>(null);
  const [deleting, setDeleting] = useState(false);

  // OTP verification dialog state
  const [otpDialog, setOtpDialog] = useState<{
    recipient: RecipientRecord | null;
    code: string;
    sending: boolean;
    verifying: boolean;
    expiresAt: number | null;        // epoch ms
    retryAt: number | null;          // epoch ms (rate-limit ends)
    attemptsRemaining: number | null;
    errorMessage: string | null;
  }>({
    recipient: null, code: '', sending: false, verifying: false,
    expiresAt: null, retryAt: null, attemptsRemaining: null, errorMessage: null,
  });

  // Tick state to drive the countdown re-render every 1s while the dialog is open.
  const [, setNow] = useState(Date.now());
  useEffect(() => {
    if (!otpDialog.recipient) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [otpDialog.recipient]);

  const [saving, setSaving] = useState(false);

  const handleStartVerify = async (recipient: RecipientRecord) => {
    if (!editing || !recipient.phone) return;
    setOtpDialog({
      recipient, code: '', sending: true, verifying: false,
      expiresAt: null, retryAt: null, attemptsRemaining: null, errorMessage: null,
    });
    try {
      await sendRecipientOtp(editing, recipient.id);
      setOtpDialog(d => ({ ...d, sending: false, expiresAt: Date.now() + 10 * 60_000 }));
      setSnackbar({ open: true, message: `Code sent to ${recipient.phone}`, severity: 'success' });
    } catch (err: any) {
      const data = err.response?.data;
      if (data?.reason === 'rate_limited' && data?.retry_at) {
        // Keep dialog open and show the rate-limit window — user can wait or cancel.
        setOtpDialog(d => ({
          ...d,
          sending: false,
          retryAt: new Date(data.retry_at).getTime(),
        }));
      } else {
        // Other failures (twilio disabled, network, etc.) — dismiss with snackbar.
        setOtpDialog({
          recipient: null, code: '', sending: false, verifying: false,
          expiresAt: null, retryAt: null, attemptsRemaining: null, errorMessage: null,
        });
        setSnackbar({ open: true, message: data?.error || 'Failed to send verification code', severity: 'error' });
      }
    }
  };

  const handleResendOtp = async () => {
    if (!editing || !otpDialog.recipient) return;
    setOtpDialog(d => ({ ...d, sending: true, retryAt: null }));
    try {
      await sendRecipientOtp(editing, otpDialog.recipient.id);
      setOtpDialog(d => ({
        ...d,
        sending: false,
        expiresAt: Date.now() + 10 * 60_000,
        attemptsRemaining: null,   // fresh code resets attempts
      }));
      setSnackbar({ open: true, message: 'New code sent', severity: 'success' });
    } catch (err: any) {
      const data = err.response?.data;
      if (data?.reason === 'rate_limited' && data?.retry_at) {
        setOtpDialog(d => ({ ...d, sending: false, retryAt: new Date(data.retry_at).getTime() }));
      } else {
        setOtpDialog(d => ({ ...d, sending: false }));
        setSnackbar({ open: true, message: data?.error || 'Failed to resend code', severity: 'error' });
      }
    }
  };

  const handleVerifyOtp = async () => {
    if (!editing || !otpDialog.recipient) return;
    const code = otpDialog.code.trim();
    if (!/^\d{4,8}$/.test(code)) return;
    setOtpDialog(d => ({ ...d, verifying: true }));
    try {
      await verifyRecipientOtp(editing, otpDialog.recipient.id, code);
      setSnackbar({ open: true, message: 'Phone verified — SMS/WhatsApp alerts unlocked', severity: 'success' });
      setOtpDialog({
        recipient: null, code: '', sending: false, verifying: false,
        expiresAt: null, retryAt: null, attemptsRemaining: null, errorMessage: null,
      });
      await fetchRecipients(editing);
    } catch (err: any) {
      const data = err.response?.data;
      if (data?.reason === 'too_many_attempts') {
        setOtpDialog({
          recipient: null, code: '', sending: false, verifying: false,
          expiresAt: null, retryAt: null, attemptsRemaining: null, errorMessage: null,
        });
        setSnackbar({ open: true, message: 'Too many wrong codes — please ask an admin to send a fresh code or try again later', severity: 'error' });
      } else if (data?.reason === 'invalid_code') {
        setOtpDialog(d => ({
          ...d,
          verifying: false,
          attemptsRemaining: typeof data.attempts_remaining === 'number' ? data.attempts_remaining : null,
          code: '',
        }));
      } else {
        setOtpDialog(d => ({ ...d, verifying: false }));
        setSnackbar({ open: true, message: data?.error || 'Verification failed — check the code and try again', severity: 'error' });
      }
    }
  };

  const fetchLocations = useCallback(async () => {
    try {
      const res = await getLocations(scopedOrgId ?? undefined);
      setLocations(res.data);
    } catch (err) {
      console.error('Failed to fetch locations:', err);
    } finally {
      setLoading(false);
    }
  }, [scopedOrgId]);

  useEffect(() => { fetchLocations(); }, [fetchLocations]);

  const fetchRecipients = useCallback(async (locationId: string) => {
    setRecipientsLoading(true);
    try {
      const res = await getRecipients(locationId);
      setRecipients(res.data);
    } catch (err) {
      console.error('Failed to fetch recipients:', err);
    } finally {
      setRecipientsLoading(false);
    }
  }, []);

  const handleAddRecipient = async () => {
    if (!newEmail.trim()) return;
    if (!editing) {
      // Create mode: buffer emails locally
      const email = newEmail.trim().toLowerCase();
      if (!pendingEmails.includes(email)) setPendingEmails(prev => [...prev, email]);
      setNewEmail('');
      return;
    }
    setAddingRecipient(true);
    try {
      await addRecipient(editing, { email: newEmail.trim(), phone: newPhone.trim() || undefined, notify_email: newNotifyEmail, notify_sms: newNotifySms, notify_whatsapp: newNotifyWhatsApp });
      setNewEmail('');
      setNewPhone('');
      setNewNotifyEmail(true);
      setNewNotifySms(false);
      setNewNotifyWhatsApp(false);
      await fetchRecipients(editing);
      setSnackbar({ open: true, message: 'Recipient added', severity: 'success' });
    } catch (err: any) {
      setSnackbar({ open: true, message: err.response?.data?.error || 'Failed to add recipient', severity: 'error' });
    } finally {
      setAddingRecipient(false);
    }
  };

  const handleToggleRecipient = async (recipient: RecipientRecord) => {
    if (!editing) return;
    try {
      await updateRecipient(editing, recipient.id, { active: !recipient.active });
      await fetchRecipients(editing);
    } catch (err: any) {
      setSnackbar({ open: true, message: 'Failed to update recipient', severity: 'error' });
    }
  };

  const handleDeleteRecipient = async (recipient: RecipientRecord) => {
    if (!editing) return;
    try {
      await deleteRecipient(editing, recipient.id);
      await fetchRecipients(editing);
      setSnackbar({ open: true, message: 'Recipient removed', severity: 'success' });
    } catch (err: any) {
      setSnackbar({ open: true, message: 'Failed to remove recipient', severity: 'error' });
    }
  };

  const handleOpen = (loc?: LocationData) => {
    setNewEmail('');
    setNewPhone('');
    setNewNotifySms(false);
    setNewNotifyWhatsApp(false);
    setPendingEmails([]);
    if (loc) {
      setEditing(loc.id);
      setForm({
        name: loc.name, site_type: loc.site_type,
        lat: loc.lat, lng: loc.lng,
        stop_radius_km: loc.stop_radius_km,
        prepare_radius_km: loc.prepare_radius_km,
        stop_flash_threshold: loc.stop_flash_threshold,
        stop_window_min: loc.stop_window_min,
        prepare_flash_threshold: loc.prepare_flash_threshold,
        prepare_window_min: loc.prepare_window_min,
        allclear_wait_min: loc.allclear_wait_min,
        persistence_alert_min: loc.persistence_alert_min ?? 10,
        alert_on_change_only: loc.alert_on_change_only ?? false,
      });
      fetchRecipients(loc.id);
    } else {
      setEditing(null);
      setForm(defaultForm);
      setRecipients([]);
    }
    setDialogOpen(true);
  };

  const handleSave = async () => {
    // Validate threshold logic
    if (!form.name.trim()) {
      setSnackbar({ open: true, message: 'Location name is required', severity: 'error' }); return;
    }
    if (form.stop_radius_km <= 0 || form.prepare_radius_km <= 0) {
      setSnackbar({ open: true, message: 'Radii must be greater than 0', severity: 'error' }); return;
    }
    if (form.prepare_radius_km <= form.stop_radius_km) {
      setSnackbar({ open: true, message: 'PREPARE radius must be larger than STOP radius', severity: 'error' }); return;
    }
    if (form.stop_flash_threshold < 1 || form.prepare_flash_threshold < 1) {
      setSnackbar({ open: true, message: 'Flash thresholds must be at least 1', severity: 'error' }); return;
    }
    if (form.stop_window_min < 1 || form.prepare_window_min < 1) {
      setSnackbar({ open: true, message: 'Time windows must be at least 1 minute', severity: 'error' }); return;
    }
    if (form.allclear_wait_min < 1) {
      setSnackbar({ open: true, message: 'All Clear wait must be at least 1 minute', severity: 'error' }); return;
    }
    if (saving) return;
    setSaving(true);
    try {
      const polygon = {
        type: 'Polygon',
        coordinates: [[
          [form.lng - 0.01, form.lat - 0.01],
          [form.lng + 0.01, form.lat - 0.01],
          [form.lng + 0.01, form.lat + 0.01],
          [form.lng - 0.01, form.lat + 0.01],
          [form.lng - 0.01, form.lat - 0.01],
        ]],
      };

      const payload: any = {
        name: form.name,
        site_type: form.site_type,
        polygon,
        centroid: { lat: form.lat, lng: form.lng },
        thresholds: {
          stop_radius_km: form.stop_radius_km,
          prepare_radius_km: form.prepare_radius_km,
          stop_flash_threshold: form.stop_flash_threshold,
          stop_window_min: form.stop_window_min,
          prepare_flash_threshold: form.prepare_flash_threshold,
          prepare_window_min: form.prepare_window_min,
          allclear_wait_min: form.allclear_wait_min,
          persistence_alert_min: form.persistence_alert_min,
          alert_on_change_only: form.alert_on_change_only,
        },
      };

      // super_admin with an org scope selected creates into that org. Otherwise
      // server defaults to the caller's own org_id (FlashAware for super_admin).
      if (isSuperAdmin && scopedOrgId && !editing) {
        payload.org_id = scopedOrgId;
      }

      if (editing) {
        await updateLocation(editing, payload);
        setDialogOpen(false);
        setSnackbar({ open: true, message: 'Location updated', severity: 'success' });
        fetchLocations();
      } else {
        const res = await createLocation(payload);
        const newId = res.data?.id;
        if (newId && pendingEmails.length > 0) {
          await Promise.all(pendingEmails.map(email => addRecipient(newId, { email, notify_email: true })));
        }
        await fetchLocations();
        setDialogOpen(false);
        setSnackbar({ open: true, message: 'Location created', severity: 'success' });
      }
    } catch (err: any) {
      setSnackbar({ open: true, message: err.response?.data?.error || 'Save failed', severity: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    setDeleting(true);
    try {
      await deleteLocation(deleteConfirm.id);
      setDeleteConfirm(null);
      setSnackbar({ open: true, message: `"${deleteConfirm.name}" deleted`, severity: 'success' });
      fetchLocations();
    } catch (err: any) {
      setSnackbar({ open: true, message: err.response?.data?.error || 'Delete failed', severity: 'error' });
    } finally {
      setDeleting(false);
    }
  };

  const handleToggle = async (loc: LocationData) => {
    try {
      await updateLocation(loc.id, { enabled: !loc.enabled });
      fetchLocations();
    } catch (err) {
      console.error('Toggle failed:', err);
    }
  };

  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  return (
    <Box>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', mb: 3, gap: 1 }}>
        <Box>
          <Typography variant="h4" sx={{ fontSize: { xs: 18, sm: 24 } }}>Location Manager</Typography>
          <Typography variant="body2" color="text.secondary">
            {locations.length} location(s) configured
          </Typography>
        </Box>
        {isAdmin && (
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => handleOpen()} size={isMobile ? 'small' : 'medium'}>
            Add Location
          </Button>
        )}
      </Box>

      {/* Mobile: card list */}
      {isMobile ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {locations.map(loc => (
            <Card key={loc.id} sx={{ bgcolor: 'background.paper' }}>
              <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, flex: 1 }}>
                    <LocationOnIcon sx={{ color: STATE_CONFIG[stateOf(loc.current_state)].color, fontSize: 20, flexShrink: 0 }} />
                    <Typography variant="body2" fontWeight={600} noWrap>{loc.name}</Typography>
                  </Box>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}>
                    <Chip
                      label={loc.current_state || '?'}
                      size="small"
                      sx={{ bgcolor: STATE_CONFIG[stateOf(loc.current_state)].color, color: STATE_CONFIG[stateOf(loc.current_state)].textColor, fontWeight: 600, fontSize: 10, height: 22 }}
                    />
                    {isAdmin && <IconButton aria-label="Edit" size="small" onClick={() => handleOpen(loc)}><EditIcon fontSize="small" /></IconButton>}
                    {isAdmin && <IconButton aria-label="Delete" size="small" color="error" onClick={() => setDeleteConfirm(loc)}><DeleteIcon fontSize="small" /></IconButton>}
                  </Box>
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                  <Chip label={loc.site_type.replace('_', ' ')} size="small" variant="outlined" sx={{ fontSize: 10, height: 22 }} />
                  {isSuperAdmin && loc.org_name && (
                    <Chip label={loc.org_name} size="small" variant="outlined" color="primary" sx={{ fontSize: 10, height: 22 }} />
                  )}
                  <Typography variant="caption" color="text.secondary">STOP: {loc.stop_radius_km}km</Typography>
                  <Typography variant="caption" color="text.secondary">PREP: {loc.prepare_radius_km}km</Typography>
                  {isAdmin && <Switch checked={loc.enabled} onChange={() => handleToggle(loc)} size="small" sx={{ ml: 'auto' }} />}
                </Box>
              </CardContent>
            </Card>
          ))}
          {locations.length === 0 && !loading && (
            <Card sx={{ textAlign: 'center', py: 4 }}>
              <Typography color="text.secondary">No locations yet. Click "Add Location" to get started.</Typography>
            </Card>
          )}
        </Box>
      ) : (
        /* Desktop: table */
        <TableContainer component={Paper} sx={{ bgcolor: 'background.paper' }}>
          <Table sx={{ minWidth: 650 }}>
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                {isSuperAdmin && <TableCell>Organisation</TableCell>}
                <TableCell>Type</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>STOP Radius</TableCell>
                <TableCell>PREPARE Radius</TableCell>
                <TableCell>Enabled</TableCell>
                <TableCell>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {locations.map(loc => (
                <TableRow key={loc.id} hover>
                  <TableCell>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <LocationOnIcon sx={{ color: STATE_CONFIG[stateOf(loc.current_state)].color, fontSize: 20 }} />
                      <Typography variant="body2" fontWeight={500}>{loc.name}</Typography>
                    </Box>
                  </TableCell>
                  {isSuperAdmin && (
                    <TableCell>
                      <Chip label={loc.org_name || '—'} size="small" variant="outlined" sx={{ fontSize: 11 }} />
                    </TableCell>
                  )}
                  <TableCell>
                    <Chip label={loc.site_type.replace('_', ' ')} size="small" variant="outlined" />
                  </TableCell>
                  <TableCell>
                    <Chip
                      label={loc.current_state || 'UNKNOWN'}
                      size="small"
                      sx={{ bgcolor: STATE_CONFIG[stateOf(loc.current_state)].color, color: STATE_CONFIG[stateOf(loc.current_state)].textColor, fontWeight: 600 }}
                    />
                  </TableCell>
                  <TableCell>{loc.stop_radius_km} km</TableCell>
                  <TableCell>{loc.prepare_radius_km} km</TableCell>
                  <TableCell>
                    {isAdmin
                      ? <Switch checked={loc.enabled} onChange={() => handleToggle(loc)} size="small" />
                      : <Chip label={loc.enabled ? 'Enabled' : 'Disabled'} size="small" color={loc.enabled ? 'success' : 'default'} variant="outlined" sx={{ fontSize: 11 }} />}
                  </TableCell>
                  <TableCell>
                    {isAdmin && (
                      <>
                        <IconButton aria-label="Edit" size="small" onClick={() => handleOpen(loc)}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                        <IconButton aria-label="Delete" size="small" color="error" onClick={() => setDeleteConfirm(loc)}>
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {locations.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={7} align="center" sx={{ py: 4 }}>
                    <Typography color="text.secondary">No locations yet. Click "Add Location" to get started.</Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Delete Confirmation Dialog */}
      {/* Phone OTP verification dialog */}
      <Dialog
        open={!!otpDialog.recipient}
        onClose={() => !otpDialog.verifying && !otpDialog.sending && setOtpDialog({
          recipient: null, code: '', sending: false, verifying: false,
          expiresAt: null, retryAt: null, attemptsRemaining: null, errorMessage: null,
        })}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Verify phone number</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2 }}>
            We sent a 6-digit code to <strong>{otpDialog.recipient?.phone}</strong>.
            Enter it below to enable SMS and WhatsApp alerts.
          </Typography>

          <TextField
            autoFocus
            fullWidth
            label="Verification code"
            value={otpDialog.code}
            onChange={e => setOtpDialog(d => ({ ...d, code: e.target.value.replace(/\D/g, '').slice(0, 8) }))}
            inputProps={{ inputMode: 'numeric', pattern: '[0-9]*', maxLength: 8 }}
            disabled={otpDialog.verifying}
            error={otpDialog.attemptsRemaining !== null && otpDialog.attemptsRemaining < MAX_VERIFY_ATTEMPTS}
            helperText={
              otpDialog.attemptsRemaining !== null
                ? `${otpDialog.attemptsRemaining} attempts remaining`
                : null
            }
          />

          {otpDialog.expiresAt && Date.now() < otpDialog.expiresAt && (
            <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'text.secondary' }}>
              Code expires in {formatCountdown(otpDialog.expiresAt - Date.now())}.
            </Typography>
          )}

          {otpDialog.expiresAt && Date.now() >= otpDialog.expiresAt && (
            <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'error.main' }}>
              Code has expired. Use "Resend code".
            </Typography>
          )}

          {otpDialog.retryAt && Date.now() < otpDialog.retryAt && (
            <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'warning.main' }}>
              Too many code requests. Try again in {formatCountdown(otpDialog.retryAt - Date.now())}.
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setOtpDialog({
              recipient: null, code: '', sending: false, verifying: false,
              expiresAt: null, retryAt: null, attemptsRemaining: null, errorMessage: null,
            })}
            disabled={otpDialog.verifying}
          >
            Cancel
          </Button>
          <Button
            onClick={handleResendOtp}
            disabled={
              otpDialog.sending ||
              otpDialog.verifying ||
              !!(otpDialog.retryAt && Date.now() < otpDialog.retryAt)
            }
          >
            {otpDialog.sending ? 'Sending…' : 'Resend code'}
          </Button>
          <Button
            variant="contained"
            onClick={handleVerifyOtp}
            disabled={
              otpDialog.verifying ||
              !/^\d{4,8}$/.test(otpDialog.code.trim()) ||
              !!(otpDialog.expiresAt && Date.now() >= otpDialog.expiresAt)
            }
            startIcon={otpDialog.verifying ? <CircularProgress size={14} /> : null}
          >
            Verify
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!deleteConfirm} onClose={() => !deleting && setDeleteConfirm(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Delete Location</DialogTitle>
        <DialogContent>
          <Typography>
            Permanently delete <strong>{deleteConfirm?.name}</strong>? This will remove all associated risk states, alerts, and recipients and cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteConfirm(null)} disabled={deleting}>Cancel</Button>
          <Button variant="contained" color="error" onClick={handleDelete} disabled={deleting}
            startIcon={deleting ? <CircularProgress size={14} /> : <DeleteIcon />}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* Add/Edit Dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="md" fullWidth fullScreen={isMobile} scroll="paper">
        <DialogTitle>
          {editing ? 'Edit Location' : 'Add New Location'}
          {!editing && isSuperAdmin && scopedOrgName && (
            <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', fontWeight: 400 }}>
              Will be created in <strong>{scopedOrgName}</strong>
            </Typography>
          )}
          {!editing && isSuperAdmin && !scopedOrgName && (
            <Typography variant="caption" sx={{ display: 'block', color: 'warning.main', fontWeight: 400 }}>
              No org selected — will be created in <strong>FlashAware</strong>. Use the picker in the top bar to target a customer org.
            </Typography>
          )}
        </DialogTitle>
        <DialogContent>
          <Grid container spacing={2} sx={{ mt: 0.5 }}>
            <Grid item xs={12} sm={6}>
              <TextField fullWidth label="Location Name" value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })} size="small" />
            </Grid>
            <Grid item xs={12} sm={6}>
              <FormControl fullWidth size="small">
                <InputLabel>Site Type</InputLabel>
                <Select value={form.site_type} label="Site Type"
                  onChange={e => setForm({ ...form, site_type: e.target.value })}>
                  {SITE_TYPES.map(t => <MenuItem key={t.value} value={t.value}>{t.label}</MenuItem>)}
                </Select>
              </FormControl>
            </Grid>

            {/* Map for centroid selection */}
            <Grid item xs={12}>
              <GeoSearchBox
                onSelect={(lat, lng, label) => setForm(f => ({
                  ...f,
                  lat,
                  lng,
                  name: f.name.trim() ? f.name : label.split(',')[0].trim(),
                }))}
              />
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1.5, mb: 0.5 }}>
                <Typography variant="subtitle2" sx={{ color: 'text.secondary', fontSize: 12 }}>
                  Or enter coordinates:
                </Typography>
                <TextField
                  label="Latitude" type="number" size="small" sx={{ width: 150 }}
                  value={form.lat}
                  inputProps={{ step: 0.0001 }}
                  onChange={e => setForm(f => ({ ...f, lat: +e.target.value }))}
                />
                <TextField
                  label="Longitude" type="number" size="small" sx={{ width: 150 }}
                  value={form.lng}
                  inputProps={{ step: 0.0001 }}
                  onChange={e => setForm(f => ({ ...f, lng: +e.target.value }))}
                />
              </Box>
              <Typography variant="subtitle2" sx={{ mb: 0.5, color: 'text.secondary', fontSize: 12 }}>
                Or click the map to set centroid ({form.lat.toFixed(4)}, {form.lng.toFixed(4)})
              </Typography>
              <Box sx={{ height: 200, borderRadius: 2, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.1)' }}>
                <MapContainer center={[form.lat, form.lng]} zoom={10}
                  style={{ height: '100%', width: '100%' }} scrollWheelZoom={true}>
                  <TileLayer
                    attribution='&copy; CARTO'
                    url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                  />
                  <MapFlyTo lat={form.lat} lng={form.lng} />
                  <CentroidPicker lat={form.lat} lng={form.lng}
                    onChange={(lat, lng) => setForm(f => ({ ...f, lat, lng }))} />
                </MapContainer>
              </Box>
            </Grid>

            <Grid item xs={12}>
              <Typography variant="subtitle2" sx={{ mb: 0.5 }}>Threshold Configuration</Typography>
              <Typography variant="caption" color="text.secondary">
                PREPARE radius must be larger than STOP radius. All windows and counts must be ≥ 1.
              </Typography>
            </Grid>
            <Grid item xs={6} sm={3}>
              <TextField fullWidth label="STOP Radius (km)" type="number" size="small"
                value={form.stop_radius_km}
                helperText="Danger zone"
                inputProps={{ min: 1 }}
                error={form.stop_radius_km >= form.prepare_radius_km}
                onChange={e => setForm({ ...form, stop_radius_km: +e.target.value })} />
            </Grid>
            <Grid item xs={6} sm={3}>
              <TextField fullWidth label="PREPARE Radius (km)" type="number" size="small"
                value={form.prepare_radius_km}
                helperText="Must be > STOP radius"
                inputProps={{ min: 1 }}
                error={form.prepare_radius_km <= form.stop_radius_km}
                onChange={e => setForm({ ...form, prepare_radius_km: +e.target.value })} />
            </Grid>
            <Grid item xs={6} sm={3}>
              <TextField fullWidth label="STOP Flash Count" type="number" size="small"
                value={form.stop_flash_threshold}
                helperText="Flashes to trigger STOP"
                inputProps={{ min: 1 }}
                onChange={e => setForm({ ...form, stop_flash_threshold: +e.target.value })} />
            </Grid>
            <Grid item xs={6} sm={3}>
              <TextField fullWidth label="STOP Window (min)" type="number" size="small"
                value={form.stop_window_min}
                helperText="Lookback for STOP count"
                inputProps={{ min: 1 }}
                onChange={e => setForm({ ...form, stop_window_min: +e.target.value })} />
            </Grid>
            <Grid item xs={6} sm={3}>
              <TextField fullWidth label="PREPARE Flash Count" type="number" size="small"
                value={form.prepare_flash_threshold}
                helperText="Flashes to trigger PREPARE"
                inputProps={{ min: 1 }}
                onChange={e => setForm({ ...form, prepare_flash_threshold: +e.target.value })} />
            </Grid>
            <Grid item xs={6} sm={3}>
              <TextField fullWidth label="PREPARE Window (min)" type="number" size="small"
                value={form.prepare_window_min}
                helperText="Lookback for PREPARE count"
                inputProps={{ min: 1 }}
                onChange={e => setForm({ ...form, prepare_window_min: +e.target.value })} />
            </Grid>
            <Grid item xs={6} sm={3}>
              <TextField fullWidth label="All Clear Wait (min)" type="number" size="small"
                value={form.allclear_wait_min}
                helperText="Wait after last flash in STOP zone"
                inputProps={{ min: 1 }}
                onChange={e => setForm({ ...form, allclear_wait_min: +e.target.value })} />
            </Grid>
            {!form.alert_on_change_only && (
              <Grid item xs={6} sm={3}>
                <TextField fullWidth label="Re-alert Interval (min)" type="number" size="small"
                  value={form.persistence_alert_min}
                  helperText="Repeat STOP/HOLD alert every N min"
                  inputProps={{ min: 1 }}
                  onChange={e => setForm({ ...form, persistence_alert_min: +e.target.value })} />
              </Grid>
            )}
            <Grid item xs={12} sm={6}>
              <FormControlLabel
                control={
                  <Switch
                    checked={form.alert_on_change_only}
                    onChange={e => setForm({ ...form, alert_on_change_only: e.target.checked })}
                    color="warning"
                  />
                }
                label={
                  <Box>
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>State-change alerts only</Typography>
                    <Typography variant="caption" color="text.secondary">
                      Only notify on transitions (e.g. ALL CLEAR → STOP → ALL CLEAR). No repeat alerts while storm persists. Ideal for wind farms.
                    </Typography>
                  </Box>
                }
              />
            </Grid>

            {/* Notification Recipients — admin only */}
            {isAdmin && (
              <>
                <Grid item xs={12}>
                  <Divider sx={{ my: 1 }} />
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
                    <EmailIcon sx={{ color: 'primary.main', fontSize: 20 }} />
                    <Typography variant="subtitle2">Notification Recipients</Typography>
                    {editing && (
                      <Chip
                        label={`${recipients.filter(r => r.active).length} active`}
                        size="small"
                        color="primary"
                        variant="outlined"
                        sx={{ fontSize: 11 }}
                      />
                    )}
                    {!editing && pendingEmails.length > 0 && (
                      <Chip
                        label={`${pendingEmails.length} added`}
                        size="small"
                        color="primary"
                        variant="outlined"
                        sx={{ fontSize: 11 }}
                      />
                    )}
                  </Box>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5, fontSize: 12 }}>
                    Recipients receive alerts via email, SMS and/or WhatsApp when the location's risk state changes. Toggle email off per recipient to suppress email for that person.
                  </Typography>
                </Grid>

                {/* Add new recipient row */}
                <Grid item xs={12}>
                  <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                    <TextField
                      label="Email address"
                      type="email"
                      size="small"
                      value={newEmail}
                      onChange={e => setNewEmail(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleAddRecipient(); }}
                      sx={{ flex: '1 1 180px', minWidth: 160 }}
                      placeholder="name@example.com"
                    />
                    <TextField
                      label="Phone (E.164)"
                      size="small"
                      value={newPhone}
                      onChange={e => setNewPhone(e.target.value)}
                      sx={{ flex: '1 1 140px', minWidth: 130 }}
                      placeholder="+27821234567"
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
                      startIcon={addingRecipient ? <CircularProgress size={14} /> : <AddIcon />}
                      onClick={handleAddRecipient}
                      disabled={!newEmail.trim() || addingRecipient}
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
                      <TableContainer component={Paper} variant="outlined" sx={{ bgcolor: 'rgba(255,255,255,0.02)' }}>
                        <Table size="small">
                          <TableHead>
                            <TableRow>
                              <TableCell sx={{ fontSize: 11 }}>Email</TableCell>
                              <TableCell sx={{ fontSize: 11 }}>Phone</TableCell>
                              <TableCell sx={{ fontSize: 11 }} align="center"><Tooltip title="Email"><EmailIcon sx={{ fontSize: 14 }} /></Tooltip></TableCell>
                              <TableCell sx={{ fontSize: 11 }} align="center"><Tooltip title="SMS"><SmsIcon sx={{ fontSize: 14 }} /></Tooltip></TableCell>
                              <TableCell sx={{ fontSize: 11 }} align="center"><Tooltip title="WhatsApp"><WhatsAppIcon sx={{ fontSize: 14 }} /></Tooltip></TableCell>
                              <TableCell sx={{ fontSize: 11 }}>Active</TableCell>
                              <TableCell sx={{ fontSize: 11, width: 48 }} />
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
                                          size="small"
                                          variant="text"
                                          onClick={() => handleStartVerify(r)}
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
                                      onChange={async () => { await updateRecipient(editing!, r.id, { notify_email: r.notify_email === false }); fetchRecipients(editing!); }}
                                      size="small"
                                      color="primary"
                                    />
                                  </Tooltip>
                                </TableCell>
                                <TableCell align="center">
                                  <Tooltip title={smsTooltip}>
                                    <span>
                                      <Switch
                                        checked={!!r.notify_sms && phoneVerified}
                                        onChange={async () => { await updateRecipient(editing!, r.id, { notify_sms: !r.notify_sms }); fetchRecipients(editing!); }}
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
                                        onChange={async () => { await updateRecipient(editing!, r.id, { notify_whatsapp: !r.notify_whatsapp }); fetchRecipients(editing!); }}
                                        size="small"
                                        disabled={!r.phone || !phoneVerified}
                                        color="success"
                                      />
                                    </span>
                                  </Tooltip>
                                </TableCell>
                                <TableCell>
                                  <Tooltip title={r.active ? 'Click to disable' : 'Click to enable'}>
                                    <Switch
                                      checked={r.active}
                                      onChange={() => handleToggleRecipient(r)}
                                      size="small"
                                    />
                                  </Tooltip>
                                </TableCell>
                                <TableCell>
                                  <Tooltip title="Remove recipient">
                                    <IconButton
                                      aria-label="Delete"
                                      size="small"
                                      color="error"
                                      onClick={() => handleDeleteRecipient(r)}
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
                                    aria-label="Delete"
                                    size="small"
                                    color="error"
                                    onClick={() => setPendingEmails(prev => prev.filter(e => e !== email))}
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
            )}
          </Grid>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)} disabled={saving}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={saving || !form.name.trim() || form.prepare_radius_km <= form.stop_radius_km}
            startIcon={saving ? <CircularProgress size={14} /> : null}
          >
            {saving ? 'Saving…' : (editing ? 'Update' : 'Create')}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={snackbar.open} autoHideDuration={4000}
        onClose={() => setSnackbar({ ...snackbar, open: false })}>
        <Alert severity={snackbar.severity} variant="filled">{snackbar.message}</Alert>
      </Snackbar>
    </Box>
  );
}

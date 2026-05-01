import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Box, Card, CardContent, Typography, Grid, Button, TextField, Select,
  MenuItem, FormControl, InputLabel, Switch, FormControlLabel, Slider,
  Dialog, DialogTitle, DialogContent, DialogActions, Chip, IconButton,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper,
  Alert, useMediaQuery, useTheme, Divider, Tooltip, CircularProgress, Skeleton,
} from '@mui/material';
import { useSearchParams } from 'react-router-dom';
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
import { getLocations, createLocation, updateLocation, deleteLocation, getRecipients, addRecipient, updateRecipient, deleteRecipient, sendRecipientOtp, verifyRecipientOtp, sendTestAlert } from './api';
import SendIcon from '@mui/icons-material/Send';
import { useCurrentUser } from './App';
import { useOrgScope } from './OrgScope';
import { useToast } from './components/ToastProvider';
import EmptyState from './components/EmptyState';
import MapTilePlaceholder from './components/MapTilePlaceholder';
import { STATE_CONFIG, stateOf } from './states';
import type { LatLngExpression } from 'leaflet';

const MAX_VERIFY_ATTEMPTS = 5;
const E164_RE = /^\+[1-9]\d{6,14}$/;
function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function hasValidCoordinates(form: Pick<FormState, 'lat' | 'lng'>): boolean {
  return (
    Number.isFinite(form.lat) && form.lat >= -90 && form.lat <= 90 &&
    Number.isFinite(form.lng) && form.lng >= -180 && form.lng <= 180 &&
    // Reject the (0, 0) "Null Island" default that comes from clearing both
    // inputs — an SA-focused operator never legitimately means the Gulf of
    // Guinea, so this is a much higher-signal save guard than just bounds.
    !(form.lat === 0 && form.lng === 0)
  );
}

function validateForm(form: FormState): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!form.name.trim()) errors.name = 'Required';
  if (!Number.isFinite(form.lat) || form.lat < -90 || form.lat > 90) {
    errors.lat = 'Latitude must be between -90 and 90';
  }
  if (!Number.isFinite(form.lng) || form.lng < -180 || form.lng > 180) {
    errors.lng = 'Longitude must be between -180 and 180';
  }
  if (!errors.lat && !errors.lng && form.lat === 0 && form.lng === 0) {
    // Catch the "form was cleared and saved as-is" case so super_admins can't
    // silently drop a placeholder pin off the coast of Africa.
    errors.lat = 'Pick a real location (search, type coordinates, or click the map)';
  }
  if (form.stop_radius_km <= 0) errors.stop_radius_km = 'Must be greater than 0';
  if (form.prepare_radius_km <= 0) errors.prepare_radius_km = 'Must be greater than 0';
  if (form.prepare_radius_km <= form.stop_radius_km) errors.prepare_radius_km = 'Must be larger than STOP radius';
  if (form.stop_flash_threshold < 1) errors.stop_flash_threshold = 'Must be at least 1';
  if (form.prepare_flash_threshold < 1) errors.prepare_flash_threshold = 'Must be at least 1';
  if (form.stop_window_min < 1) errors.stop_window_min = 'Must be at least 1';
  if (form.prepare_window_min < 1) errors.prepare_window_min = 'Must be at least 1';
  if (form.allclear_wait_min < 1) errors.allclear_wait_min = 'Must be at least 1';
  return errors;
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
  is_demo: boolean;
  enabled: boolean;
  active_recipient_count?: number;
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
  is_demo: boolean;
}

const defaultForm: FormState = {
  name: '', site_type: 'mine', lat: -26.2041, lng: 28.0473,
  stop_radius_km: 10, prepare_radius_km: 20, stop_flash_threshold: 1,
  stop_window_min: 15, prepare_flash_threshold: 1, prepare_window_min: 15,
  allclear_wait_min: 30, persistence_alert_min: 10, alert_on_change_only: false,
  is_demo: false,
};

// EUMETSAT MTG Lightning Imager has a typical horizontal location accuracy of
// ~3 km, so a STOP radius below this is almost always a misconfig — a real
// strike on the site centroid will plot outside the radius about half the
// time, and the engine won't trigger. The editor surfaces a warning rather
// than blocking, since some power-user setups (e.g. ground-truth comparisons)
// genuinely want a tight zone.
const STOP_RADIUS_WARNING_THRESHOLD_KM = 3;

type NotifyStatesMap = Partial<Record<'STOP' | 'PREPARE' | 'HOLD' | 'ALL_CLEAR' | 'DEGRADED', boolean>>;

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
  // Per-state opt-in. Missing keys treated as subscribed by the server.
  notify_states: NotifyStatesMap;
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

  const toast = useToast();
  const [locations, setLocations] = useState<LocationData[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(defaultForm);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

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
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [editorTilesLoaded, setEditorTilesLoaded] = useState(false);

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
      toast.success(`Code sent to ${recipient.phone}`);
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
        toast.error(data?.error || 'Failed to send verification code');
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
      toast.success('New code sent');
    } catch (err: any) {
      const data = err.response?.data;
      if (data?.reason === 'rate_limited' && data?.retry_at) {
        setOtpDialog(d => ({ ...d, sending: false, retryAt: new Date(data.retry_at).getTime() }));
      } else {
        setOtpDialog(d => ({ ...d, sending: false }));
        toast.error(data?.error || 'Failed to resend code');
      }
    }
  };

  const handleVerifyOtp = async () => {
    if (!editing || !otpDialog.recipient) return;
    const code = otpDialog.code.trim();
    if (!/^\d{6}$/.test(code)) return;
    setOtpDialog(d => ({ ...d, verifying: true }));
    try {
      await verifyRecipientOtp(editing, otpDialog.recipient.id, code);
      toast.success('Phone verified — SMS/WhatsApp alerts unlocked');
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
        toast.error('Too many wrong codes — please ask an admin to send a fresh code or try again later');
      } else if (data?.reason === 'invalid_code') {
        setOtpDialog(d => ({
          ...d,
          verifying: false,
          attemptsRemaining: typeof data.attempts_remaining === 'number' ? data.attempts_remaining : null,
          code: '',
        }));
      } else {
        setOtpDialog(d => ({ ...d, verifying: false }));
        toast.error(data?.error || 'Verification failed — check the code and try again');
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

  // Deep-link support: /locations?edit=<uuid> auto-opens the editor for that
  // location. Powers the NO RECIPIENTS chip on Dashboard StatusCard ("→ add
  // recipient now") and any future "Open in editor" affordances. We wait
  // for the locations list to arrive so the form can be pre-populated.
  const [searchParams, setSearchParams] = useSearchParams();
  const editIdFromUrl = searchParams.get('edit');
  useEffect(() => {
    if (!editIdFromUrl || loading) return;
    const target = locations.find(l => l.id === editIdFromUrl);
    if (target) {
      handleOpen(target);
      // Strip the param so a refresh doesn't keep re-opening, and so the
      // Cancel button leaves a clean URL.
      setSearchParams(prev => {
        const next = new URLSearchParams(prev);
        next.delete('edit');
        return next;
      }, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editIdFromUrl, loading, locations]);

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
      toast.success('Recipient added');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to add recipient');
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
      toast.error('Failed to update recipient');
    }
  };

  const handleDeleteRecipient = async (recipient: RecipientRecord) => {
    if (!editing) return;
    try {
      await deleteRecipient(editing, recipient.id);
      await fetchRecipients(editing);
      toast.success('Recipient removed');
    } catch (err: any) {
      toast.error('Failed to remove recipient');
    }
  };

  const [testingRecipientId, setTestingRecipientId] = useState<number | null>(null);
  const handleSendTest = async (recipient: RecipientRecord) => {
    if (!editing) return;
    setTestingRecipientId(recipient.id);
    try {
      const res = await sendTestAlert(editing, recipient.id);
      const sent = res.data.attempted.filter(c => c.ok).map(c => c.channel);
      const failed = res.data.attempted.filter(c => !c.ok && !c.skipped).map(c => `${c.channel} (${c.error || 'failed'})`);
      if (res.data.any_sent) {
        const msg = `Test sent via: ${sent.join(', ')}${failed.length ? ` — failed: ${failed.join('; ')}` : ''}`;
        if (failed.length) toast.error(msg); else toast.success(msg);
      } else {
        const reasons = res.data.attempted
          .filter(c => c.skipped)
          .map(c => `${c.channel}: ${c.skipped?.replace('_', ' ')}`)
          .join(', ');
        toast.error(`No channels sent. ${reasons || 'Check channel toggles and phone verification.'}`);
      }
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Test send failed');
    } finally {
      setTestingRecipientId(null);
    }
  };

  // Optimistic toggle for recipient channel/state switches: flip local state
  // immediately, push to server in the background, and reconcile on response.
  // Removes the perceived lag from full re-fetch on every click.
  const optimisticUpdateRecipient = async (
    recipient: RecipientRecord,
    patch: Parameters<typeof updateRecipient>[2],
  ) => {
    if (!editing) return;
    const prev = recipients;
    setRecipients(rs => rs.map(r => r.id === recipient.id ? { ...r, ...(patch as any) } : r));
    try {
      await updateRecipient(editing, recipient.id, patch);
    } catch (err: any) {
      setRecipients(prev);  // rollback
      toast.error('Failed to update recipient');
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
        is_demo: loc.is_demo ?? false,
      });
      fetchRecipients(loc.id);
    } else {
      setEditing(null);
      setForm(defaultForm);
      setRecipients([]);
    }
    // Dialog (and therefore MapContainer) unmounts on close, so the placeholder
    // overlay needs to re-show every time the dialog reopens.
    setEditorTilesLoaded(false);
    setDialogOpen(true);
  };

  const clearError = (key: string) => setFieldErrors(prev => {
    const { [key]: _, ...rest } = prev;
    return rest;
  });

  // Live cross-field validation. After a field changes, re-run validators
  // and update errors that are *already visible* — plus the "PREPARE > STOP"
  // cross-field check, which is the most common foot-gun.
  const setFormField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    const next = { ...form, [key]: value } as FormState;
    setForm(next);
    setFieldErrors(prev => {
      const all = validateForm(next);
      const updated: Record<string, string> = {};
      // Keep updating errors that were already surfaced (e.g. after a save attempt)
      for (const k of Object.keys(prev)) {
        if (all[k]) updated[k] = all[k];
      }
      // Always live-flag the radius cross-check while the user is editing radii
      if ((key === 'prepare_radius_km' || key === 'stop_radius_km') && all.prepare_radius_km) {
        updated.prepare_radius_km = all.prepare_radius_km;
      }
      return updated;
    });
  };

  const handleSave = async () => {
    const errors = validateForm(form);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      toast.error('Please fix the highlighted fields');
      return;
    }
    if (saving) return;

    // Soft guards before save: armed location with no recipients dispatches
    // nothing on STOP; STOP radius below MTG-LI's typical accuracy (~3 km)
    // gives lots of false negatives. We confirm rather than block — power
    // users have legitimate reasons for both, and a noisy block is worse
    // than a single confirm dialog.
    const editingLoc = editing ? locations.find(l => l.id === editing) : null;
    const willBeArmed = editingLoc ? editingLoc.enabled !== false : true;
    const willHaveRecipients = editing
      ? recipients.some(r => r.active)
      : pendingEmails.length > 0;
    if (willBeArmed && !willHaveRecipients && !form.is_demo) {
      const proceed = window.confirm(
        `"${form.name}" will be armed but has no notification recipients — STOP / PREPARE alerts will be logged but no email, SMS or WhatsApp will be sent. Save anyway?`
      );
      if (!proceed) return;
    }
    if (form.stop_radius_km < STOP_RADIUS_WARNING_THRESHOLD_KM && !form.is_demo) {
      const proceed = window.confirm(
        `STOP radius of ${form.stop_radius_km} km is below the EUMETSAT MTG-LI typical accuracy of ~3 km. Real strikes on the site centroid will plot outside the radius about half the time, and the engine may miss them. Save anyway?`
      );
      if (!proceed) return;
    }

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
        is_demo: form.is_demo,
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
        toast.success('Location updated');
        fetchLocations();
      } else {
        // Create the location first; only treat THIS step's failure as a
        // "Save failed" — once the location exists, recipient errors are
        // partial successes and need a different message so the admin doesn't
        // assume the location wasn't created and try again (creating a dupe).
        const res = await createLocation(payload);
        const newId = res.data?.id;
        let recipientFailures = 0;
        if (newId && pendingEmails.length > 0) {
          const results = await Promise.allSettled(
            pendingEmails.map(email => addRecipient(newId, { email, notify_email: true }))
          );
          recipientFailures = results.filter(r => r.status === 'rejected').length;
        }
        await fetchLocations();
        setDialogOpen(false);
        if (recipientFailures > 0) {
          toast.warning(
            `Location created, but ${recipientFailures} of ${pendingEmails.length} recipient(s) couldn't be added — open the location to retry.`
          );
        } else {
          toast.success('Location created');
        }
      }
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    setDeleting(true);
    try {
      await deleteLocation(deleteConfirm.id);
      const name = deleteConfirm.name;
      setDeleteConfirm(null);
      setDeleteConfirmName('');
      toast.success(`"${name}" deleted`);
      fetchLocations();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Delete failed');
    } finally {
      setDeleting(false);
    }
  };

  const closeDeleteDialog = () => {
    if (deleting) return;
    setDeleteConfirm(null);
    setDeleteConfirmName('');
  };

  const handleToggle = async (loc: LocationData) => {
    // Optimistic flip so the switch doesn't sit "thinking" on every click.
    // Snapshot prev so we can roll back cleanly on error — the previous version
    // silently swallowed errors, which made a failed toggle look like a stuck
    // UI bug. Toast on failure tells the operator to retry / check status.
    const prev = locations;
    setLocations(ls => ls.map(l => l.id === loc.id ? { ...l, enabled: !l.enabled } : l));
    try {
      await updateLocation(loc.id, { enabled: !loc.enabled });
      fetchLocations();
    } catch (err: any) {
      setLocations(prev);
      toast.error(err.response?.data?.error || `Failed to ${loc.enabled ? 'disable' : 'enable'} location`);
    }
  };

  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  return (
    <Box>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', mb: 3, gap: 1 }}>
        <Box>
          <Typography variant="h4" sx={{ fontSize: { xs: 18, sm: 24 } }}>Location Manager</Typography>
          {loading ? (
            // Skeleton instead of "0 locations configured (0 enabled)" during
            // the initial fetch — operators were seeing what looked like an
            // empty org for the half-second before data arrived.
            <Skeleton variant="text" sx={{ width: 220, height: 20 }} />
          ) : (() => {
            const total = locations.length;
            const enabled = locations.filter(l => l.enabled).length;
            const demo = locations.filter(l => l.is_demo).length;
            const tooltip = `${enabled} enabled · ${total - enabled} disabled${demo > 0 ? ` · ${demo} demo` : ''}. Disabled and demo locations are excluded from the dashboard.`;
            return (
              <Tooltip title={tooltip}>
                <Typography variant="body2" color="text.secondary" sx={{ cursor: 'help', textDecoration: 'underline dotted' }}>
                  {total} location{total === 1 ? '' : 's'} configured ({enabled} enabled{demo > 0 && `, ${demo} demo`})
                </Typography>
              </Tooltip>
            );
          })()}
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
          {loading && [0, 1, 2].map(i => (
            <Skeleton key={`m-skel-${i}`} variant="rounded" height={88} />
          ))}
          {!loading && locations.map(loc => (
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
            <Card>
              <EmptyState
                icon={<LocationOnIcon />}
                title="No locations yet"
                description="Add your first monitored location to start tracking lightning risk."
                cta={isAdmin ? { label: 'Add location', icon: <AddIcon />, onClick: () => handleOpen() } : undefined}
              />
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
              {loading && [0, 1, 2, 3].map(i => (
                <TableRow key={`d-skel-${i}`}>
                  <TableCell colSpan={isSuperAdmin ? 8 : 7} sx={{ py: 1 }}>
                    <Skeleton variant="text" height={28} />
                  </TableCell>
                </TableRow>
              ))}
              {!loading && locations.map(loc => (
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
                  <TableCell colSpan={isSuperAdmin ? 8 : 7} sx={{ py: 4 }}>
                    <EmptyState
                      icon={<LocationOnIcon />}
                      title="No locations yet"
                      description="Add your first monitored location to start tracking lightning risk."
                      cta={isAdmin ? { label: 'Add location', icon: <AddIcon />, onClick: () => handleOpen() } : undefined}
                    />
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
            onChange={e => setOtpDialog(d => ({ ...d, code: e.target.value.replace(/\D/g, '').slice(0, 6) }))}
            inputProps={{ inputMode: 'numeric', pattern: '[0-9]*', maxLength: 6, autoComplete: 'one-time-code' }}
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
              !/^\d{6}$/.test(otpDialog.code.trim()) ||
              !!(otpDialog.expiresAt && Date.now() >= otpDialog.expiresAt)
            }
            startIcon={otpDialog.verifying ? <CircularProgress size={14} /> : null}
          >
            Verify
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!deleteConfirm} onClose={closeDeleteDialog} maxWidth="sm" fullWidth>
        <DialogTitle>Delete Location</DialogTitle>
        <DialogContent>
          <Alert severity="error" sx={{ mb: 2 }}>
            This will permanently delete <strong>{deleteConfirm?.name}</strong> along with:
            <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
              <li>All risk-state history</li>
              <li>All alerts and acknowledgements</li>
              <li>All notification recipients</li>
            </ul>
            This cannot be undone.
          </Alert>
          <Typography variant="body2" sx={{ mb: 2 }}>
            Type <strong>{deleteConfirm?.name}</strong> to confirm:
          </Typography>
          <TextField
            autoFocus
            fullWidth
            size="small"
            placeholder={deleteConfirm?.name}
            value={deleteConfirmName}
            onChange={e => setDeleteConfirmName(e.target.value)}
            disabled={deleting}
            onKeyDown={e => {
              if (e.key === 'Enter' && deleteConfirmName === deleteConfirm?.name && !deleting) {
                handleDelete();
              }
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDeleteDialog} disabled={deleting}>Cancel</Button>
          <Button variant="contained" color="error" onClick={handleDelete}
            disabled={deleting || deleteConfirmName !== deleteConfirm?.name}
            startIcon={deleting ? <CircularProgress size={14} /> : <DeleteIcon />}>
            {deleting ? 'Deleting…' : 'Delete location'}
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
                onChange={e => setFormField('name', e.target.value)}
                size="small"
                placeholder={form.is_demo
                  ? 'e.g. Replay demo (Free State storm, 2026-04-08)'
                  : 'e.g. Sun City Golf Course'}
                error={!!fieldErrors.name}
                // Demo names like "Replay demo 04082026" leave readers
                // guessing whether 08 is the day or the month. Encourage an
                // unambiguous YYYY-MM-DD inside the parens.
                helperText={fieldErrors.name ?? (form.is_demo
                  ? 'Tip: include the storm date in YYYY-MM-DD form so 08/04 isn’t ambiguous.'
                  : undefined)} />
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
                  value={Number.isFinite(form.lat) ? form.lat : ''}
                  inputProps={{ step: 0.0001, min: -90, max: 90 }}
                  error={!!fieldErrors.lat}
                  helperText={fieldErrors.lat}
                  onChange={e => setFormField('lat', e.target.value === '' ? NaN : +e.target.value)}
                />
                <TextField
                  label="Longitude" type="number" size="small" sx={{ width: 150 }}
                  value={Number.isFinite(form.lng) ? form.lng : ''}
                  inputProps={{ step: 0.0001, min: -180, max: 180 }}
                  error={!!fieldErrors.lng}
                  helperText={fieldErrors.lng}
                  onChange={e => setFormField('lng', e.target.value === '' ? NaN : +e.target.value)}
                />
              </Box>
              <Typography variant="subtitle2" sx={{ mb: 0.5, color: 'text.secondary', fontSize: 12 }}>
                Or click the map to set centroid ({form.lat.toFixed(4)}, {form.lng.toFixed(4)})
              </Typography>
              <Box sx={{ position: 'relative', height: { xs: 220, sm: 360 }, borderRadius: 2, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.1)' }}>
                <MapTilePlaceholder visible={!editorTilesLoaded} />
                <MapContainer center={[form.lat, form.lng]} zoom={10}
                  style={{ height: '100%', width: '100%' }} scrollWheelZoom={true}>
                  {/* Voyager basemap instead of dark_all — the editor map is
                      where labels matter most ("am I dropping the centroid on
                      the right block?") and the dark variant rendered town
                      names too low-contrast at zoomed-in views. The dashboard
                      monitoring map keeps the dark variant for the storm
                      visuals. */}
                  <TileLayer
                    attribution='&copy; CARTO'
                    url="https://{s}.basemaps.cartocdn.com/voyager/{z}/{x}/{y}{r}.png"
                    eventHandlers={{ load: () => setEditorTilesLoaded(true) }}
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
            <Grid item xs={12}>
              <Typography variant="subtitle2" sx={{ mt: 2, mb: 0.5 }}>How this site triggers alerts</Typography>
              <Typography variant="caption" color="text.secondary">
                Go <strong>STOP</strong> when {form.stop_flash_threshold} or more flashes land within{' '}
                <strong>{form.stop_radius_km} km</strong> in any{' '}
                <strong>{form.stop_window_min}-minute window</strong>. Go{' '}
                <strong>PREPARE</strong> on the first flash within{' '}
                <strong>{form.prepare_radius_km} km</strong>. Return to{' '}
                <strong>ALL CLEAR</strong> after{' '}
                <strong>{form.allclear_wait_min} minutes</strong> with no flashes in the STOP radius.
              </Typography>
            </Grid>
            <Grid item xs={6} sm={3}>
              <TextField fullWidth label="STOP Radius (km)" type="number" size="small"
                value={form.stop_radius_km}
                helperText={fieldErrors.stop_radius_km ?? 'Distance considered immediately dangerous'}
                inputProps={{ min: 1 }}
                error={!!fieldErrors.stop_radius_km}
                onChange={e => setFormField('stop_radius_km', +e.target.value)} />
            </Grid>
            <Grid item xs={6} sm={3}>
              <TextField fullWidth label="PREPARE Radius (km)" type="number" size="small"
                value={form.prepare_radius_km}
                helperText={fieldErrors.prepare_radius_km ?? 'Wider awareness zone (must be larger than STOP radius)'}
                inputProps={{ min: 1 }}
                error={!!fieldErrors.prepare_radius_km}
                onChange={e => setFormField('prepare_radius_km', +e.target.value)} />
            </Grid>
            <Grid item xs={6} sm={3}>
              <TextField fullWidth label="STOP Flash Count" type="number" size="small"
                value={form.stop_flash_threshold}
                helperText={fieldErrors.stop_flash_threshold ?? 'Number of flashes that triggers STOP'}
                inputProps={{ min: 1 }}
                error={!!fieldErrors.stop_flash_threshold}
                onChange={e => setFormField('stop_flash_threshold', +e.target.value)} />
            </Grid>
            <Grid item xs={6} sm={3}>
              <TextField fullWidth label="STOP Window (min)" type="number" size="small"
                value={form.stop_window_min}
                helperText={fieldErrors.stop_window_min ?? 'Time window for counting flashes'}
                inputProps={{ min: 1 }}
                error={!!fieldErrors.stop_window_min}
                onChange={e => setFormField('stop_window_min', +e.target.value)} />
            </Grid>
            <Grid item xs={6} sm={3}>
              <TextField fullWidth label="PREPARE Flash Count" type="number" size="small"
                value={form.prepare_flash_threshold}
                helperText={fieldErrors.prepare_flash_threshold ?? 'Flashes within PREPARE radius that triggers PREPARE'}
                inputProps={{ min: 1 }}
                error={!!fieldErrors.prepare_flash_threshold}
                onChange={e => setFormField('prepare_flash_threshold', +e.target.value)} />
            </Grid>
            <Grid item xs={6} sm={3}>
              <TextField fullWidth label="PREPARE Window (min)" type="number" size="small"
                value={form.prepare_window_min}
                helperText={fieldErrors.prepare_window_min ?? 'Time window for the PREPARE count'}
                inputProps={{ min: 1 }}
                error={!!fieldErrors.prepare_window_min}
                onChange={e => setFormField('prepare_window_min', +e.target.value)} />
            </Grid>
            <Grid item xs={6} sm={3}>
              <TextField fullWidth label="All Clear Wait (min)" type="number" size="small"
                value={form.allclear_wait_min}
                helperText={fieldErrors.allclear_wait_min ?? 'Quiet minutes required before returning to ALL CLEAR'}
                inputProps={{ min: 1 }}
                error={!!fieldErrors.allclear_wait_min}
                onChange={e => setFormField('allclear_wait_min', +e.target.value)} />
            </Grid>
            {!form.alert_on_change_only && (
              <Grid item xs={6} sm={3}>
                <TextField fullWidth label="Re-alert Interval (min)" type="number" size="small"
                  value={form.persistence_alert_min}
                  helperText="Re-send alerts every N minutes while STOP/HOLD persists"
                  inputProps={{ min: 1 }}
                  onChange={e => setForm({ ...form, persistence_alert_min: Math.max(1, +e.target.value) })} />
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
            <Grid item xs={12} sm={6}>
              <FormControlLabel
                control={
                  <Switch
                    checked={form.is_demo}
                    onChange={e => setForm({ ...form, is_demo: e.target.checked })}
                  />
                }
                label={
                  <Box>
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>Mark as demo / test data</Typography>
                    <Typography variant="caption" color="text.secondary">
                      Hides this location from the main dashboard until "Show demo" is toggled on. Risk engine still evaluates it so test alerts work.
                    </Typography>
                  </Box>
                }
              />
            </Grid>
            {/* Inline warnings for the two most common foot-guns. Surfaced
                under the threshold grid so they appear right after the
                offending value is typed, not just at save-confirm time. */}
            {form.stop_radius_km > 0 && form.stop_radius_km < STOP_RADIUS_WARNING_THRESHOLD_KM && !form.is_demo && (
              <Grid item xs={12}>
                <Alert severity="warning" sx={{ fontSize: 12, py: 0.5 }}>
                  <strong>{form.stop_radius_km} km STOP radius is below the typical EUMETSAT MTG-LI accuracy (~3 km).</strong>{' '}
                  Real strikes on the centroid often plot outside this radius, so the engine may miss them. Consider ≥ 3 km unless this is a calibration site.
                </Alert>
              </Grid>
            )}

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
                      error={newPhone.length > 0 && !E164_RE.test(newPhone.trim())}
                      helperText={newPhone.length > 0 && !E164_RE.test(newPhone.trim()) ? 'Use E.164: +<country><number>' : ''}
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
                                        : <Button size="small" sx={{ fontSize: 10, py: 0, px: 0.5, minWidth: 0 }} onClick={() => handleStartVerify(r)}>Verify</Button>}
                                    </Typography>
                                  )}
                                </Box>
                                <Switch checked={r.active} size="small"
                                  onChange={() => optimisticUpdateRecipient(r, { active: !r.active })} />
                              </Box>
                              <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', mb: 1 }}>
                                <FormControlLabel
                                  control={<Switch size="small" checked={r.notify_email !== false}
                                    onChange={() => optimisticUpdateRecipient(r, { notify_email: r.notify_email === false })} />}
                                  label={<Typography sx={{ fontSize: 11 }}>Email</Typography>}
                                />
                                <FormControlLabel
                                  control={<Switch size="small" checked={!!r.notify_sms && phoneVerified}
                                    disabled={!r.phone || !phoneVerified}
                                    onChange={() => optimisticUpdateRecipient(r, { notify_sms: !r.notify_sms })} />}
                                  label={<Typography sx={{ fontSize: 11 }}>SMS</Typography>}
                                />
                                <FormControlLabel
                                  control={<Switch size="small" color="success" checked={!!r.notify_whatsapp && phoneVerified}
                                    disabled={!r.phone || !phoneVerified}
                                    onChange={() => optimisticUpdateRecipient(r, { notify_whatsapp: !r.notify_whatsapp })} />}
                                  label={<Typography sx={{ fontSize: 11 }}>WhatsApp</Typography>}
                                />
                              </Box>
                              <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 1 }}>
                                {(['STOP', 'HOLD', 'PREPARE', 'ALL_CLEAR', 'DEGRADED'] as const).map(s => {
                                  const cfg = STATE_CONFIG[s];
                                  const subscribed = r.notify_states?.[s] !== false;
                                  const toggle = () => {
                                    const next: NotifyStatesMap = { ...(r.notify_states ?? {}), [s]: !subscribed };
                                    optimisticUpdateRecipient(r, { notify_states: next });
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
                                  size="small"
                                  variant="outlined"
                                  startIcon={testingRecipientId === r.id ? <CircularProgress size={12} /> : <SendIcon sx={{ fontSize: 14 }} />}
                                  onClick={() => handleSendTest(r)}
                                  disabled={!r.active || testingRecipientId === r.id}
                                  sx={{ fontSize: 11 }}
                                >
                                  Send test
                                </Button>
                                <IconButton aria-label="Delete recipient" size="small" color="error" onClick={() => handleDeleteRecipient(r)}>
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
                                <Tooltip title="Risk states this recipient is subscribed to. Click a chip to toggle.">
                                  <span>States</span>
                                </Tooltip>
                              </TableCell>
                              <TableCell sx={{ fontSize: 11 }}>Active</TableCell>
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
                                      onChange={() => optimisticUpdateRecipient(r, { notify_email: r.notify_email === false })}
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
                                        onChange={() => optimisticUpdateRecipient(r, { notify_sms: !r.notify_sms })}
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
                                        onChange={() => optimisticUpdateRecipient(r, { notify_whatsapp: !r.notify_whatsapp })}
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
                                    return (
                                      <Tooltip key={s} title={`${cfg.label} alerts: ${subscribed ? 'on' : 'off'} — click to toggle`}>
                                        <Box
                                          onClick={() => {
                                            const next: NotifyStatesMap = { ...(r.notify_states ?? {}), [s]: !subscribed };
                                            optimisticUpdateRecipient(r, { notify_states: next });
                                          }}
                                          onKeyDown={(e) => {
                                            // role="button" requires Space and Enter to activate (WAI-ARIA).
                                            // preventDefault on Space stops the page from scrolling.
                                            if (e.key === ' ' || e.key === 'Enter') {
                                              e.preventDefault();
                                              const next: NotifyStatesMap = { ...(r.notify_states ?? {}), [s]: !subscribed };
                                              optimisticUpdateRecipient(r, { notify_states: next });
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
                                  <Tooltip title={r.active ? 'Click to disable' : 'Click to enable'}>
                                    <Switch
                                      checked={r.active}
                                      onChange={() => optimisticUpdateRecipient(r, { active: !r.active })}
                                      size="small"
                                    />
                                  </Tooltip>
                                </TableCell>
                                <TableCell sx={{ whiteSpace: 'nowrap' }}>
                                  <Tooltip title="Send a test message via every channel this recipient has on">
                                    <span>
                                      <IconButton
                                        aria-label="Send test"
                                        size="small"
                                        color="primary"
                                        onClick={() => handleSendTest(r)}
                                        disabled={!r.active || testingRecipientId === r.id}
                                      >
                                        {testingRecipientId === r.id ? <CircularProgress size={14} /> : <SendIcon fontSize="small" />}
                                      </IconButton>
                                    </span>
                                  </Tooltip>
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
            disabled={
              saving ||
              !form.name.trim() ||
              !hasValidCoordinates(form) ||
              form.prepare_radius_km <= form.stop_radius_km
            }
            startIcon={saving ? <CircularProgress size={14} /> : null}
          >
            {saving ? 'Saving…' : (editing ? 'Update' : 'Create')}
          </Button>
        </DialogActions>
      </Dialog>

    </Box>
  );
}

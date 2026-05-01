import React, { useState, useEffect, useCallback } from 'react';
import {
  Box, Card, Typography, Grid, Button, TextField, Select,
  MenuItem, FormControl, InputLabel, Switch, FormControlLabel, Slider,
  Dialog, DialogTitle, DialogContent, DialogActions, Chip,
  Paper, Alert, useMediaQuery, useTheme, Tooltip, CircularProgress, Skeleton,
} from '@mui/material';
import { useSearchParams } from 'react-router-dom';
import AddIcon from '@mui/icons-material/Add';
import LocationOnIcon from '@mui/icons-material/LocationOn';
import { MapContainer, TileLayer, Polygon, CircleMarker, Popup } from 'react-leaflet';
import { getLocations, createLocation, updateLocation, deleteLocation, getRecipients, addRecipient, updateRecipient, deleteRecipient, sendTestAlert } from './api';
import { usePhoneVerification, useTickWhileOpen } from './hooks/usePhoneVerification';
import { useCurrentUser } from './App';
import { useOrgScope } from './OrgScope';
import { useToast } from './components/ToastProvider';
import MapTilePlaceholder from './components/MapTilePlaceholder';
import { GeoSearchBox } from './components/GeoSearchBox';
import { MapFlyTo, CentroidPicker } from './components/MapPickerHelpers';
import { OtpVerificationDialog } from './components/OtpVerificationDialog';
import { DeleteLocationDialog } from './components/DeleteLocationDialog';
import { LocationListView } from './components/LocationListView';
import { RecipientPanel } from './components/RecipientPanel';
import type { LatLngExpression } from 'leaflet';

const E164_RE = /^\+[1-9]\d{6,14}$/;

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

// Recipient types live in RecipientPanel (the single owner of the recipient
// table UI); we just import them so handlers compile.
import type { RecipientRecord, RecipientUpdate } from './components/RecipientPanel';

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

  // Recipient management state. The "new recipient" form-row state lives
  // inside <RecipientPanel> — only the persistent recipient list and the
  // pending-emails buffer (used during create-mode) are owned here.
  const [recipients, setRecipients] = useState<RecipientRecord[]>([]);
  const [recipientsLoading, setRecipientsLoading] = useState(false);
  const [pendingEmails, setPendingEmails] = useState<string[]>([]);
  const [deleteConfirm, setDeleteConfirm] = useState<LocationData | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [editorTilesLoaded, setEditorTilesLoaded] = useState(false);

  // OTP verification flow — owned by the usePhoneVerification hook. The
  // dialog component is pure-presentation; we just forward `otp.*` into it.
  const otp = usePhoneVerification({
    locationId: editing,
    onVerified: () => { if (editing) void fetchRecipients(editing); },
  });
  useTickWhileOpen(!!otp.state.recipient);

  const [saving, setSaving] = useState(false);

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

  // Adapter from <RecipientPanel> intent → API call. The panel owns the
  // form-row state and resets its own inputs after a successful add; we
  // just persist and re-fetch.
  const handleAddRecipientPersisted = async (input: { email: string; phone?: string; notify_email: boolean; notify_sms: boolean; notify_whatsapp: boolean }) => {
    if (!editing) return;
    try {
      await addRecipient(editing, input);
      await fetchRecipients(editing);
      toast.success('Recipient added');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to add recipient');
      throw err; // re-throw so the panel doesn't clear its inputs on failure
    }
  };

  const handleAddRecipientPending = (email: string) => {
    setPendingEmails(prev => prev.includes(email) ? prev : [...prev, email]);
  };

  const handleRemovePendingEmail = (email: string) => {
    setPendingEmails(prev => prev.filter(e => e !== email));
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
    // RecipientPanel's form-row state is local; it resets when the dialog
    // unmounts on close (no keepMounted), so we only have to clear the
    // parent-owned pending-email buffer.
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

      <LocationListView
        locations={locations}
        loading={loading}
        isAdmin={isAdmin}
        isSuperAdmin={isSuperAdmin}
        isMobile={isMobile}
        onAdd={() => handleOpen()}
        onEdit={(loc) => handleOpen(loc as LocationData)}
        onDelete={(loc) => setDeleteConfirm(loc as LocationData)}
        onToggleEnabled={(loc) => handleToggle(loc as LocationData)}
      />

      <OtpVerificationDialog
        state={otp.state}
        onCodeChange={otp.setCode}
        onResend={otp.resend}
        onVerify={otp.verify}
        onClose={otp.close}
      />

      <DeleteLocationDialog
        location={deleteConfirm}
        confirmName={deleteConfirmName}
        onConfirmNameChange={setDeleteConfirmName}
        onClose={closeDeleteDialog}
        onDelete={handleDelete}
        deleting={deleting}
      />

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

            {isAdmin && (
              <RecipientPanel
                editing={editing}
                recipients={recipients}
                recipientsLoading={recipientsLoading}
                pendingEmails={pendingEmails}
                testingRecipientId={testingRecipientId}
                onAddPersisted={handleAddRecipientPersisted}
                onAddPending={handleAddRecipientPending}
                onRemovePending={handleRemovePendingEmail}
                onUpdate={(r, patch) => optimisticUpdateRecipient(r, patch)}
                onDelete={handleDeleteRecipient}
                onSendTest={handleSendTest}
                onStartVerify={otp.start}
              />
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

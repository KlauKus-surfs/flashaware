import React, { useState, useEffect, useCallback } from 'react';
import { Box, Typography, Button, Tooltip, useMediaQuery, useTheme, Skeleton } from '@mui/material';
import { useSearchParams } from 'react-router-dom';
import AddIcon from '@mui/icons-material/Add';
import api, {
  getLocations,
  createLocation,
  updateLocation,
  deleteLocation,
  getRecipients,
  addRecipient,
  updateRecipient,
  deleteRecipient,
  sendTestAlert,
} from './api';
import { usePhoneVerification, useTickWhileOpen } from './hooks/usePhoneVerification';
import { useCurrentUser } from './App';
import { useOrgScope } from './OrgScope';
import { useToast } from './components/ToastProvider';
import { useConfirm } from './components/ConfirmDialog';
import { OtpVerificationDialog } from './components/OtpVerificationDialog';
import { DeleteLocationDialog } from './components/DeleteLocationDialog';
import { LocationListView } from './components/LocationListView';
import { LocationFormDialog } from './components/LocationFormDialog';
import {
  FormState,
  defaultForm,
  validateForm,
  STOP_RADIUS_WARNING_THRESHOLD_KM,
} from './components/locationForm';
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
  stop_lit_pixels: number;
  stop_incidence: number;
  prepare_lit_pixels: number;
  prepare_incidence: number;
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

// Recipient types live in RecipientPanel (the single owner of the recipient
// table UI); we just import them so handlers compile.
import type { RecipientRecord } from './components/RecipientPanel';
import { logger } from './utils/logger';

export default function LocationEditor() {
  const currentUser = useCurrentUser();
  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'super_admin';
  const isSuperAdmin = currentUser?.role === 'super_admin';
  const { scopedOrgId, scopedOrgName } = useOrgScope();

  const toast = useToast();
  const confirm = useConfirm();
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
  // Map tile-load state moved into MapBase (which lives inside the dialog
  // and unmounts on close, so it auto-resets without parent help).

  // OTP verification flow — owned by the usePhoneVerification hook. The
  // dialog component is pure-presentation; we just forward `otp.*` into it.
  const otp = usePhoneVerification({
    locationId: editing,
    onVerified: () => {
      if (editing) void fetchRecipients(editing);
    },
  });
  useTickWhileOpen(!!otp.state.recipient);

  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{
    stop_triggers: number;
    prepare_triggers: number;
  } | null>(null);

  const runPreview = async () => {
    if (!editing) return;
    try {
      const { data } = await api.post(`/locations/${editing}/preview-thresholds`, {
        stop_lit_pixels: form.stop_lit_pixels,
        stop_incidence: form.stop_incidence,
        prepare_lit_pixels: form.prepare_lit_pixels,
        prepare_incidence: form.prepare_incidence,
      });
      setPreview(data);
    } catch (err) {
      logger.warn('runPreview failed', err);
    }
  };

  const fetchLocations = useCallback(async () => {
    try {
      const res = await getLocations(scopedOrgId ?? undefined);
      setLocations(res.data);
    } catch (err) {
      logger.error('Failed to fetch locations:', err);
    } finally {
      setLoading(false);
    }
  }, [scopedOrgId]);

  useEffect(() => {
    fetchLocations();
  }, [fetchLocations]);

  // Deep-link support: /locations?edit=<uuid> auto-opens the editor for that
  // location. Powers the NO RECIPIENTS chip on Dashboard StatusCard ("→ add
  // recipient now") and any future "Open in editor" affordances. We wait
  // for the locations list to arrive so the form can be pre-populated.
  const [searchParams, setSearchParams] = useSearchParams();
  const editIdFromUrl = searchParams.get('edit');
  useEffect(() => {
    if (!editIdFromUrl || loading) return;
    const target = locations.find((l) => l.id === editIdFromUrl);
    if (target) {
      handleOpen(target);
      // Strip the param so a refresh doesn't keep re-opening, and so the
      // Cancel button leaves a clean URL.
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete('edit');
          return next;
        },
        { replace: true },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editIdFromUrl, loading, locations]);

  const fetchRecipients = useCallback(async (locationId: string) => {
    setRecipientsLoading(true);
    try {
      const res = await getRecipients(locationId);
      setRecipients(res.data);
    } catch (err) {
      logger.error('Failed to fetch recipients:', err);
    } finally {
      setRecipientsLoading(false);
    }
  }, []);

  // Adapter from <RecipientPanel> intent → API call. The panel owns the
  // form-row state and resets its own inputs after a successful add; we
  // just persist and re-fetch.
  const handleAddRecipientPersisted = async (input: {
    email: string;
    phone?: string;
    notify_email: boolean;
    notify_sms: boolean;
    notify_whatsapp: boolean;
  }) => {
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
    setPendingEmails((prev) => (prev.includes(email) ? prev : [...prev, email]));
  };

  const handleRemovePendingEmail = (email: string) => {
    setPendingEmails((prev) => prev.filter((e) => e !== email));
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
      const sent = res.data.attempted.filter((c) => c.ok).map((c) => c.channel);
      const failed = res.data.attempted
        .filter((c) => !c.ok && !c.skipped)
        .map((c) => `${c.channel} (${c.error || 'failed'})`);
      if (res.data.any_sent) {
        const msg = `Test sent via: ${sent.join(', ')}${failed.length ? ` — failed: ${failed.join('; ')}` : ''}`;
        if (failed.length) toast.error(msg);
        else toast.success(msg);
      } else {
        const reasons = res.data.attempted
          .filter((c) => c.skipped)
          .map((c) => `${c.channel}: ${c.skipped?.replace('_', ' ')}`)
          .join(', ');
        toast.error(
          `No channels sent. ${reasons || 'Check channel toggles and phone verification.'}`,
        );
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
    setRecipients((rs) => rs.map((r) => (r.id === recipient.id ? { ...r, ...(patch as any) } : r)));
    try {
      await updateRecipient(editing, recipient.id, patch);
    } catch (err: any) {
      setRecipients(prev); // rollback
      toast.error('Failed to update recipient');
    }
  };

  const handleOpen = (loc?: LocationData) => {
    // RecipientPanel's form-row state is local; it resets when the dialog
    // unmounts on close (no keepMounted), so we only have to clear the
    // parent-owned pending-email buffer.
    setPendingEmails([]);
    setPreview(null);
    if (loc) {
      setEditing(loc.id);
      setForm({
        name: loc.name,
        site_type: loc.site_type,
        lat: loc.lat,
        lng: loc.lng,
        stop_radius_km: loc.stop_radius_km,
        prepare_radius_km: loc.prepare_radius_km,
        stop_flash_threshold: loc.stop_flash_threshold,
        stop_window_min: loc.stop_window_min,
        prepare_flash_threshold: loc.prepare_flash_threshold,
        prepare_window_min: loc.prepare_window_min,
        stop_lit_pixels: loc.stop_lit_pixels ?? 1,
        stop_incidence: loc.stop_incidence ?? 5,
        prepare_lit_pixels: loc.prepare_lit_pixels ?? 1,
        prepare_incidence: loc.prepare_incidence ?? 1,
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
    setDialogOpen(true);
  };

  const clearError = (key: string) =>
    setFieldErrors((prev) => {
      const { [key]: _, ...rest } = prev;
      return rest;
    });

  // Live cross-field validation. After a field changes, re-run validators
  // and update errors that are *already visible* — plus the "PREPARE > STOP"
  // cross-field check, which is the most common foot-gun.
  const setFormField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    const next = { ...form, [key]: value } as FormState;
    setForm(next);
    setFieldErrors((prev) => {
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
    // nothing on STOP; STOP radius below the LI footprint (~4.5 km nadir,
    // ≤10 km at 45° lat) gives lots of false negatives. We confirm rather
    // than block — power users have legitimate reasons for both, and a
    // noisy block is worse than a single confirm dialog.
    const editingLoc = editing ? locations.find((l) => l.id === editing) : null;
    const willBeArmed = editingLoc ? editingLoc.enabled !== false : true;
    const willHaveRecipients = editing
      ? recipients.some((r) => r.active)
      : pendingEmails.length > 0;
    if (willBeArmed && !willHaveRecipients && !form.is_demo) {
      const proceed = await confirm({
        title: 'Save armed location with no recipients?',
        message: `"${form.name}" will be armed but has no notification recipients — STOP / PREPARE alerts will be logged but no email, SMS or WhatsApp will be sent.`,
        confirmLabel: 'Save anyway',
        tone: 'warning',
      });
      if (!proceed) return;
    }
    if (form.stop_radius_km < STOP_RADIUS_WARNING_THRESHOLD_KM && !form.is_demo) {
      const proceed = await confirm({
        title: `STOP radius of ${form.stop_radius_km} km is below the LI footprint`,
        message: `The EUMETSAT MTG-LI per-flash footprint is 4.5 km at the sub-satellite point and up to ~10 km at 45° latitude (typically 5–8 km over Southern Africa). Real strikes on the site centroid will often plot outside a ${form.stop_radius_km} km radius and the engine may miss them.`,
        confirmLabel: 'Save anyway',
        tone: 'warning',
      });
      if (!proceed) return;
    }

    setSaving(true);
    try {
      const polygon = {
        type: 'Polygon',
        coordinates: [
          [
            [form.lng - 0.01, form.lat - 0.01],
            [form.lng + 0.01, form.lat - 0.01],
            [form.lng + 0.01, form.lat + 0.01],
            [form.lng - 0.01, form.lat + 0.01],
            [form.lng - 0.01, form.lat - 0.01],
          ],
        ],
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
          stop_lit_pixels: form.stop_lit_pixels,
          stop_incidence: form.stop_incidence,
          prepare_lit_pixels: form.prepare_lit_pixels,
          prepare_incidence: form.prepare_incidence,
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
            pendingEmails.map((email) => addRecipient(newId, { email, notify_email: true })),
          );
          recipientFailures = results.filter((r) => r.status === 'rejected').length;
        }
        await fetchLocations();
        setDialogOpen(false);
        if (recipientFailures > 0) {
          toast.warning(
            `Location created, but ${recipientFailures} of ${pendingEmails.length} recipient(s) couldn't be added — open the location to retry.`,
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
    setLocations((ls) => ls.map((l) => (l.id === loc.id ? { ...l, enabled: !l.enabled } : l)));
    try {
      await updateLocation(loc.id, { enabled: !loc.enabled });
      fetchLocations();
    } catch (err: any) {
      setLocations(prev);
      toast.error(
        err.response?.data?.error || `Failed to ${loc.enabled ? 'disable' : 'enable'} location`,
      );
    }
  };

  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'center',
          mb: 3,
          gap: 1,
        }}
      >
        <Box>
          <Typography variant="h4" sx={{ fontSize: { xs: 18, sm: 24 } }}>
            Location Manager
          </Typography>
          {loading ? (
            // Skeleton instead of "0 locations configured (0 enabled)" during
            // the initial fetch — operators were seeing what looked like an
            // empty org for the half-second before data arrived.
            <Skeleton variant="text" sx={{ width: 220, height: 20 }} />
          ) : (
            (() => {
              const total = locations.length;
              const enabled = locations.filter((l) => l.enabled).length;
              const demo = locations.filter((l) => l.is_demo).length;
              const tooltip = `${enabled} enabled · ${total - enabled} disabled${demo > 0 ? ` · ${demo} demo` : ''}. Disabled and demo locations are excluded from the dashboard.`;
              return (
                <Tooltip title={tooltip}>
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ cursor: 'help', textDecoration: 'underline dotted' }}
                  >
                    {total} location{total === 1 ? '' : 's'} configured ({enabled} enabled
                    {demo > 0 && `, ${demo} demo`})
                  </Typography>
                </Tooltip>
              );
            })()
          )}
        </Box>
        {isAdmin && (
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => handleOpen()}
            size={isMobile ? 'small' : 'medium'}
          >
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
      <LocationFormDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSave={handleSave}
        saving={saving}
        editing={editing}
        isMobile={isMobile}
        isAdmin={isAdmin}
        isSuperAdmin={isSuperAdmin}
        scopedOrgName={scopedOrgName}
        form={form}
        setForm={setForm}
        setFormField={setFormField}
        fieldErrors={fieldErrors}
        preview={preview}
        onRunPreview={runPreview}
        recipients={recipients}
        recipientsLoading={recipientsLoading}
        pendingEmails={pendingEmails}
        testingRecipientId={testingRecipientId}
        onAddRecipientPersisted={handleAddRecipientPersisted}
        onAddRecipientPending={handleAddRecipientPending}
        onRemovePendingEmail={handleRemovePendingEmail}
        onUpdateRecipient={(r, patch) => optimisticUpdateRecipient(r, patch)}
        onDeleteRecipient={handleDeleteRecipient}
        onSendTestRecipient={handleSendTest}
        onStartVerifyRecipient={otp.start}
      />
    </Box>
  );
}

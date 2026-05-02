import React from 'react';
import {
  Box, Grid, Button, TextField, Select, MenuItem, FormControl, InputLabel,
  Switch, FormControlLabel, Dialog, DialogTitle, DialogContent, DialogActions,
  Typography, Alert, CircularProgress,
} from '@mui/material';
import { MapBase } from './MapBase';
import { GeoSearchBox } from './GeoSearchBox';
import { MapFlyTo, CentroidPicker } from './MapPickerHelpers';
import { RecipientPanel, RecipientRecord, RecipientUpdate, NewRecipientInput } from './RecipientPanel';
import {
  FormState, SITE_TYPES, STOP_RADIUS_WARNING_THRESHOLD_KM, hasValidCoordinates,
} from './locationForm';

// Add/Edit Location dialog. Pure-presentation: the parent owns form state,
// recipient state, and lifecycle handlers; this component only wires them
// to the form widgets and the recipient panel inside the dialog.
//
// Props are deliberately flat (rather than grouped objects) so it's obvious
// in the JSX which intents are forwarded — at the cost of a longer prop list.
interface Props {
  open: boolean;
  onClose: () => void;
  onSave: () => void;
  saving: boolean;

  editing: string | null;
  isMobile: boolean;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  scopedOrgName: string | null | undefined;

  // Form state ---
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  setFormField: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  fieldErrors: Record<string, string>;

  // Recipient panel pass-through ---
  recipients: RecipientRecord[];
  recipientsLoading: boolean;
  pendingEmails: string[];
  testingRecipientId: number | null;
  onAddRecipientPersisted: (input: NewRecipientInput) => Promise<void>;
  onAddRecipientPending: (email: string) => void;
  onRemovePendingEmail: (email: string) => void;
  onUpdateRecipient: (recipient: RecipientRecord, patch: RecipientUpdate) => void;
  onDeleteRecipient: (recipient: RecipientRecord) => void;
  onSendTestRecipient: (recipient: RecipientRecord) => void;
  onStartVerifyRecipient: (recipient: RecipientRecord) => void;
}

export function LocationFormDialog({
  open, onClose, onSave, saving,
  editing, isMobile, isAdmin, isSuperAdmin, scopedOrgName,
  form, setForm, setFormField, fieldErrors,
  recipients, recipientsLoading, pendingEmails, testingRecipientId,
  onAddRecipientPersisted, onAddRecipientPending, onRemovePendingEmail,
  onUpdateRecipient, onDeleteRecipient, onSendTestRecipient, onStartVerifyRecipient,
}: Props) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth fullScreen={isMobile} scroll="paper">
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
                onChange={e => setForm(f => ({ ...f, site_type: e.target.value }))}>
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
            {/* Voyager basemap instead of dark_all — the editor map is
                where labels matter most ("am I dropping the centroid on
                the right block?") and the dark variant rendered town
                names too low-contrast at zoomed-in views. The dashboard
                monitoring map keeps the dark variant for the storm
                visuals. */}
            <MapBase
              basemap="voyager"
              center={[form.lat, form.lng]}
              zoom={10}
              sx={{ height: { xs: 220, sm: 360 }, borderRadius: 2, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.1)' }}
            >
              <MapFlyTo lat={form.lat} lng={form.lng} />
              <CentroidPicker lat={form.lat} lng={form.lng}
                onChange={(lat, lng) => setForm(f => ({ ...f, lat, lng }))} />
            </MapBase>
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
                onChange={e => setForm(f => ({ ...f, persistence_alert_min: Math.max(1, +e.target.value) }))} />
            </Grid>
          )}
          <Grid item xs={12} sm={6}>
            <FormControlLabel
              control={
                <Switch
                  checked={form.alert_on_change_only}
                  onChange={e => setForm(f => ({ ...f, alert_on_change_only: e.target.checked }))}
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
                  onChange={e => setForm(f => ({ ...f, is_demo: e.target.checked }))}
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
                <strong>{form.stop_radius_km} km STOP radius is below the EUMETSAT MTG-LI footprint (4.5 km at the sub-satellite point, ≤10 km at 45° latitude per the official MTG spec
                  {' '}
                  <Box
                    component="a"
                    href="https://www.eumetsat.int/mtg-lightning-imager"
                    target="_blank"
                    rel="noopener noreferrer"
                    sx={{ color: 'inherit', textDecoration: 'underline', fontWeight: 'normal' }}
                    aria-label="EUMETSAT Lightning Imager mission page"
                  >
                    [spec]
                  </Box>
                ).</strong>{' '}
                Over Southern Africa the per-flash footprint is typically 5–8 km, so a real strike on the site centroid will often plot outside this radius and the engine will silently miss it. Consider ≥ 5 km unless this is a calibration / ground-truth site.
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
              onAddPersisted={onAddRecipientPersisted}
              onAddPending={onAddRecipientPending}
              onRemovePending={onRemovePendingEmail}
              onUpdate={onUpdateRecipient}
              onDelete={onDeleteRecipient}
              onSendTest={onSendTestRecipient}
              onStartVerify={onStartVerifyRecipient}
            />
          )}
        </Grid>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button
          variant="contained"
          onClick={onSave}
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
  );
}

import React, { useEffect, useState } from 'react';
import {
  Box, Dialog, DialogTitle, DialogContent, DialogActions, TextField,
  FormControl, InputLabel, Select, MenuItem, Button, Alert, IconButton,
  Tooltip, Typography,
} from '@mui/material';
import NavigateBeforeIcon from '@mui/icons-material/NavigateBefore';
import NavigateNextIcon from '@mui/icons-material/NavigateNext';
import api from '../api';
import { useToast } from './ToastProvider';
import InfoTip from './InfoTip';
import { helpBody, helpTitle } from '../help/copy';

// Single source of truth for the user CRUD dialogs. Both UserManagement (flat,
// admin's own org) and OrgManagement (per-org expander, super_admin) used to
// ship near-identical Add/Edit/Delete dialogs that drifted in subtle ways
// (validation, copy, severity of confirmation prompts). Bug fixes had to land
// in two places. Centralising here keeps behaviour identical and the next
// change only has to land once.

export type Role = 'admin' | 'operator' | 'viewer';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  created_at?: string;
}

const PASSWORD_MIN = 6;

// --------------------------------------------------------------------------
// Add User
// --------------------------------------------------------------------------

interface AddUserDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  // When provided, the create call includes org_id so super_admin can target a
  // specific tenant from OrgManagement. Omitted, the server defaults to the
  // caller's own org (the UserManagement flow).
  orgId?: string;
  // Used purely for the dialog title context ("Add User to Acme Corp").
  orgName?: string;
}

export function AddUserDialog({ open, onClose, onCreated, orgId, orgName }: AddUserDialogProps) {
  const toast = useToast();
  const [form, setForm] = useState({ email: '', name: '', role: 'viewer' as Role, password: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Reset form whenever the dialog re-opens — otherwise stale state from a
  // previous open (e.g. password the user typed and then cancelled) lingers.
  useEffect(() => {
    if (open) {
      setForm({ email: '', name: '', role: 'viewer', password: '' });
      setError('');
    }
  }, [open]);

  const canSubmit =
    form.email.trim().length > 0 &&
    form.name.trim().length > 0 &&
    form.password.length >= PASSWORD_MIN &&
    !saving;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError('');
    try {
      const body: any = { ...form };
      if (orgId) body.org_id = orgId;
      await api.post('/users', body);
      toast.success(`User ${form.email} added`);
      onCreated();
      onClose();
    } catch (e: any) {
      setError(e.response?.data?.error || 'Failed to add user');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={() => !saving && onClose()} maxWidth="xs" fullWidth>
      <DialogTitle>{orgName ? `Add User to ${orgName}` : 'Add User'}</DialogTitle>
      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
          <TextField autoFocus label="Full Name" size="small" required
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          <TextField label="Email" type="email" size="small" required
            value={form.email}
            onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
          <TextField label="Password" type="password" size="small" required
            value={form.password}
            onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
            helperText={`Minimum ${PASSWORD_MIN} characters`} />
          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5 }}>
            <FormControl size="small" required fullWidth>
              <InputLabel>Role</InputLabel>
              <Select value={form.role} label="Role"
                onChange={e => setForm(f => ({ ...f, role: e.target.value as Role }))}>
                <MenuItem value="admin">Admin</MenuItem>
                <MenuItem value="operator">Operator</MenuItem>
                <MenuItem value="viewer">Viewer</MenuItem>
              </Select>
            </FormControl>
            <InfoTip variant="dialog" title={helpTitle('role_permissions')} body={helpBody('role_permissions')} />
          </Box>
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="contained" onClick={handleSubmit} disabled={!canSubmit}>
          {saving ? 'Adding…' : 'Add User'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// --------------------------------------------------------------------------
// Edit User
// --------------------------------------------------------------------------

interface EditUserDialogProps {
  // Edit dialog is open whenever target is non-null, so callers can use a
  // single piece of state instead of separate open/target booleans.
  target: UserRow | null;
  onClose: () => void;
  onSaved: () => void;
  // Optional prev/next walkthrough — only UserManagement provides this. When
  // omitted, the navigation chrome is hidden entirely.
  navigation?: {
    index: number;       // 0-based
    total: number;
    onPrev: () => void;
    onNext: () => void;
  };
}

export function EditUserDialog({ target, onClose, onSaved, navigation }: EditUserDialogProps) {
  const toast = useToast();
  const [form, setForm] = useState({ email: '', name: '', role: 'viewer' as Role, newPassword: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Sync local form state every time the target user changes — including
  // prev/next navigation, which keeps the dialog open but swaps the user.
  useEffect(() => {
    if (target) {
      setForm({ email: target.email, name: target.name, role: target.role, newPassword: '' });
      setError('');
    }
  }, [target]);

  const canSubmit =
    form.email.trim().length > 0 &&
    form.name.trim().length > 0 &&
    !saving;

  const handleSubmit = async () => {
    if (!target || !canSubmit) return;
    setSaving(true);
    setError('');
    try {
      const payload: any = { email: form.email, name: form.name, role: form.role };
      if (form.newPassword.trim()) payload.password = form.newPassword.trim();
      await api.put(`/users/${target.id}`, payload);
      toast.success(`${form.name} updated`);
      onSaved();
      onClose();
    } catch (e: any) {
      setError(e.response?.data?.error || 'Failed to update user');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!target} onClose={() => !saving && onClose()} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>Edit User</span>
        {navigation && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Tooltip title="Previous user">
              <span>
                <IconButton size="small" onClick={navigation.onPrev} disabled={navigation.index <= 0}>
                  <NavigateBeforeIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Typography variant="caption" color="text.secondary" sx={{ minWidth: 40, textAlign: 'center' }}>
              {navigation.index + 1} / {navigation.total}
            </Typography>
            <Tooltip title="Next user">
              <span>
                <IconButton size="small" onClick={navigation.onNext} disabled={navigation.index >= navigation.total - 1}>
                  <NavigateNextIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Box>
        )}
      </DialogTitle>
      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
          <TextField autoFocus label="Full Name" size="small" required
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          <TextField label="Email" type="email" size="small" required
            value={form.email}
            onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5 }}>
            <FormControl size="small" required fullWidth>
              <InputLabel>Role</InputLabel>
              <Select value={form.role} label="Role"
                onChange={e => setForm(f => ({ ...f, role: e.target.value as Role }))}>
                <MenuItem value="admin">Admin</MenuItem>
                <MenuItem value="operator">Operator</MenuItem>
                <MenuItem value="viewer">Viewer</MenuItem>
              </Select>
            </FormControl>
            <InfoTip variant="dialog" title={helpTitle('role_permissions')} body={helpBody('role_permissions')} />
          </Box>
          <TextField label="New Password" type="password" size="small"
            value={form.newPassword}
            onChange={e => setForm(f => ({ ...f, newPassword: e.target.value }))}
            helperText="Leave blank to keep current password" />
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="contained" onClick={handleSubmit} disabled={!canSubmit}>
          {saving ? 'Saving…' : 'Save Changes'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// --------------------------------------------------------------------------
// Delete User
// --------------------------------------------------------------------------

interface DeleteUserDialogProps {
  target: UserRow | null;
  onClose: () => void;
  onDeleted: () => void;
}

export function DeleteUserDialog({ target, onClose, onDeleted }: DeleteUserDialogProps) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);

  const handleConfirm = async () => {
    if (!target) return;
    setSaving(true);
    try {
      await api.delete(`/users/${target.id}`);
      toast.success(`${target.name} deleted`);
      onDeleted();
      onClose();
    } catch (e: any) {
      toast.error(e.response?.data?.error || 'Failed to delete user');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!target} onClose={() => !saving && onClose()} maxWidth="xs" fullWidth>
      <DialogTitle>Delete User</DialogTitle>
      <DialogContent>
        <Alert severity="warning">
          Permanently delete <strong>{target?.name}</strong> ({target?.email})? This cannot be undone.
        </Alert>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="contained" color="error" onClick={handleConfirm} disabled={saving}>
          {saving ? 'Deleting…' : 'Delete User'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

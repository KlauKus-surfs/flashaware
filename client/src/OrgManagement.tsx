import React, { useState, useEffect, useCallback } from 'react';
import {
  Box, Typography, Paper, Button, TextField, Dialog, DialogTitle,
  DialogContent, DialogActions, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, Chip, IconButton, Alert, Snackbar, Tooltip,
  Divider, CircularProgress, Select, MenuItem, FormControl, InputLabel,
  Collapse, List, ListItem, ListItemText,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import LinkIcon from '@mui/icons-material/Link';
import BusinessIcon from '@mui/icons-material/Business';
import SendIcon from '@mui/icons-material/Send';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import api from './api';

interface Org {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  deleted_at: string | null;
  user_count: number;
  location_count: number;
}

interface Invite {
  id: string;
  token: string;
  org_id: string;
  org_name: string;
  role: string;
  email: string | null;
  used_at: string | null;
  expires_at: string;
  created_at: string;
}

interface OrgUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'operator' | 'viewer';
  created_at: string;
}

interface CreateInviteResponse {
  invite_url: string;
  org_name: string;
  role: string;
  email: string | null;
  email_sent: boolean;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export default function OrgManagement() {
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [snack, setSnack] = useState('');

  // Create org dialog
  const [createOrgOpen, setCreateOrgOpen] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [orgSlug, setOrgSlug] = useState('');
  const [orgSlugManual, setOrgSlugManual] = useState(false);
  const [orgInviteEmail, setOrgInviteEmail] = useState('');
  const [orgSaving, setOrgSaving] = useState(false);
  const [orgError, setOrgError] = useState('');

  // Create invite dialog
  const [createInviteOpen, setCreateInviteOpen] = useState(false);
  const [inviteOrgId, setInviteOrgId] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'operator' | 'viewer'>('viewer');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteSaving, setInviteSaving] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [generatedLink, setGeneratedLink] = useState<{ url: string; org_name: string; role: string; email: string | null; email_sent: boolean } | null>(null);

  // Expanded org rows (showing their invites)
  const [expandedOrg, setExpandedOrg] = useState<string | null>(null);

  // Delete org dialog
  const [deleteOrgOpen, setDeleteOrgOpen] = useState(false);
  const [orgToDelete, setOrgToDelete] = useState<Org | null>(null);
  const [deleteOrgConfirmName, setDeleteOrgConfirmName] = useState('');
  const [deleteOrgSaving, setDeleteOrgSaving] = useState(false);

  // Per-org users (loaded on expand)
  const [orgUsers, setOrgUsers] = useState<Record<string, OrgUser[]>>({});
  const [orgUsersLoading, setOrgUsersLoading] = useState<Record<string, boolean>>({});

  // Add user dialog
  const [addUserOrgId, setAddUserOrgId] = useState<string | null>(null);
  const [addUserForm, setAddUserForm] = useState({ email: '', name: '', role: 'viewer' as 'admin' | 'operator' | 'viewer', password: '' });
  const [addUserSaving, setAddUserSaving] = useState(false);
  const [addUserError, setAddUserError] = useState('');

  // Edit user dialog
  const [editUserTarget, setEditUserTarget] = useState<OrgUser | null>(null);
  const [editUserForm, setEditUserForm] = useState({ name: '', email: '', role: 'viewer' as 'admin' | 'operator' | 'viewer', newPassword: '' });
  const [editUserSaving, setEditUserSaving] = useState(false);
  const [editUserError, setEditUserError] = useState('');

  // Delete user dialog
  const [deleteUserTarget, setDeleteUserTarget] = useState<OrgUser | null>(null);
  const [deleteUserOrgId, setDeleteUserOrgId] = useState<string | null>(null);
  const [deleteUserSaving, setDeleteUserSaving] = useState(false);

  const loadOrgUsers = useCallback(async (orgId: string) => {
    setOrgUsersLoading(prev => ({ ...prev, [orgId]: true }));
    try {
      const res = await api.get(`/orgs/${orgId}/users`);
      setOrgUsers(prev => ({ ...prev, [orgId]: res.data }));
    } catch {
      setOrgUsers(prev => ({ ...prev, [orgId]: [] }));
    } finally {
      setOrgUsersLoading(prev => ({ ...prev, [orgId]: false }));
    }
  }, []);

  const handleToggleExpand = async (orgId: string) => {
    if (expandedOrg === orgId) { setExpandedOrg(null); return; }
    setExpandedOrg(orgId);
    await loadOrgUsers(orgId);
  };

  const handleAddUser = async () => {
    if (!addUserOrgId) return;
    setAddUserSaving(true);
    setAddUserError('');
    try {
      await api.post('/users', { ...addUserForm, org_id: addUserOrgId });
      setSnack(`User ${addUserForm.email} added`);
      const orgId = addUserOrgId;
      setAddUserOrgId(null);
      await loadOrgUsers(orgId);
      loadAll();
    } catch (e: any) {
      setAddUserError(e.response?.data?.error || 'Failed to add user');
    } finally {
      setAddUserSaving(false);
    }
  };

  const handleEditUser = async () => {
    if (!editUserTarget) return;
    setEditUserSaving(true);
    setEditUserError('');
    try {
      const payload: any = { email: editUserForm.email, name: editUserForm.name, role: editUserForm.role };
      if (editUserForm.newPassword) payload.password = editUserForm.newPassword;
      await api.put(`/users/${editUserTarget.id}`, payload);
      setSnack(`${editUserForm.name} updated`);
      const orgId = Object.keys(orgUsers).find(oid => orgUsers[oid]?.some(u => u.id === editUserTarget.id));
      setEditUserTarget(null);
      if (orgId) await loadOrgUsers(orgId);
    } catch (e: any) {
      setEditUserError(e.response?.data?.error || 'Failed to update user');
    } finally {
      setEditUserSaving(false);
    }
  };

  const handleDeleteUser = async () => {
    if (!deleteUserTarget || !deleteUserOrgId) return;
    setDeleteUserSaving(true);
    try {
      await api.delete(`/users/${deleteUserTarget.id}`);
      setSnack(`${deleteUserTarget.name} deleted`);
      const orgId = deleteUserOrgId;
      setDeleteUserTarget(null);
      setDeleteUserOrgId(null);
      await loadOrgUsers(orgId);
      loadAll();
    } catch (e: any) {
      setSnack(e.response?.data?.error || 'Failed to delete user');
      setDeleteUserTarget(null);
      setDeleteUserOrgId(null);
    } finally {
      setDeleteUserSaving(false);
    }
  };

  const [showDeleted, setShowDeleted] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [orgsRes, invitesRes] = await Promise.all([
        api.get('/orgs', { params: showDeleted ? { include_deleted: 'true' } : undefined }),
        api.get('/orgs/invites'),
      ]);
      setOrgs(orgsRes.data);
      setInvites(invitesRes.data);
    } catch (e: any) {
      setError(e.response?.data?.error || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [showDeleted]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Auto-generate slug from name
  useEffect(() => {
    if (!orgSlugManual) setOrgSlug(slugify(orgName));
  }, [orgName, orgSlugManual]);

  const handleCreateOrg = async () => {
    setOrgSaving(true);
    setOrgError('');
    try {
      const body: any = { name: orgName.trim(), slug: orgSlug.trim() };
      if (orgInviteEmail.trim()) body.invite_email = orgInviteEmail.trim();
      const res = await api.post('/orgs', body);
      setSnack(
        res.data.onboarding_invite_sent && res.data.onboarding_invite_email
          ? `Organisation "${orgName}" created and onboarding email sent to ${res.data.onboarding_invite_email}`
          : `Organisation "${orgName}" created`
      );
      setCreateOrgOpen(false);
      setOrgName('');
      setOrgSlug('');
      setOrgSlugManual(false);
      setOrgInviteEmail('');
      loadAll();
    } catch (e: any) {
      setOrgError(e.response?.data?.error || 'Failed to create organisation');
    } finally {
      setOrgSaving(false);
    }
  };

  const handleCreateInvite = async () => {
    setInviteSaving(true);
    setInviteError('');
    try {
      const body: any = { org_id: inviteOrgId, role: inviteRole };
      if (inviteEmail.trim()) body.email = inviteEmail.trim();
      const res = await api.post<CreateInviteResponse>('/orgs/invites', body);
      setGeneratedLink({
        url: res.data.invite_url,
        org_name: res.data.org_name,
        role: res.data.role,
        email: res.data.email,
        email_sent: res.data.email_sent,
      });
      setInviteEmail('');
      loadAll();
    } catch (e: any) {
      setInviteError(e.response?.data?.error || 'Failed to create invite');
    } finally {
      setInviteSaving(false);
    }
  };

  const openDeleteOrgDialog = (org: Org) => {
    setOrgToDelete(org);
    setDeleteOrgConfirmName('');
    setDeleteOrgOpen(true);
  };

  const handleDeleteOrg = async () => {
    if (!orgToDelete) return;
    setDeleteOrgSaving(true);
    try {
      await api.delete(`/orgs/${orgToDelete.id}`);
      setSnack(`Organisation "${orgToDelete.name}" deleted. Data preserved for 30 days; restore until then or it will be permanently removed.`);
      setDeleteOrgOpen(false);
      setOrgToDelete(null);
      loadAll();
    } catch (e: any) {
      setSnack(e.response?.data?.error || 'Failed to delete organisation');
      setDeleteOrgOpen(false);
    } finally {
      setDeleteOrgSaving(false);
    }
  };

  const handleRestoreOrg = async (org: Org) => {
    try {
      await api.post(`/orgs/${org.id}/restore`);
      setSnack(`Organisation "${org.name}" restored`);
      loadAll();
    } catch (e: any) {
      setSnack(e.response?.data?.error || 'Failed to restore organisation');
    }
  };

  const openInviteDialog = (orgId: string) => {
    setInviteOrgId(orgId);
    setInviteRole('viewer');
    setInviteEmail('');
    setInviteError('');
    setGeneratedLink(null);
    setCreateInviteOpen(true);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setSnack('Copied to clipboard!');
  };

  const orgInvites = (orgId: string) => invites.filter(i => i.org_id === orgId);

  const isExpired = (expires_at: string) => new Date(expires_at) < new Date();

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <BusinessIcon sx={{ color: 'primary.main', fontSize: 28 }} />
          <Typography variant="h5">Organisation Management</Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <Tooltip title="Soft-deleted orgs remain restorable for 30 days">
            <Button
              size="small"
              variant={showDeleted ? 'contained' : 'outlined'}
              color="inherit"
              onClick={() => setShowDeleted(s => !s)}
              sx={{ mr: 1 }}
            >
              {showDeleted ? 'Hide deleted' : 'Show deleted'}
            </Button>
          </Tooltip>
          <Button variant="outlined" startIcon={<LinkIcon />} onClick={() => { setInviteOrgId(orgs[0]?.id || ''); setInviteRole('viewer'); setInviteEmail(''); setInviteError(''); setGeneratedLink(null); setCreateInviteOpen(true); }}>
            Generate Invite
          </Button>
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => { setCreateOrgOpen(true); setOrgName(''); setOrgSlug(''); setOrgSlugManual(false); setOrgInviteEmail(''); setOrgError(''); }}>
            New Organisation
          </Button>
        </Box>
      </Box>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      ) : (
        <TableContainer component={Paper}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell />
                <TableCell><strong>Organisation</strong></TableCell>
                <TableCell><strong>Slug</strong></TableCell>
                <TableCell align="center"><strong>Users</strong></TableCell>
                <TableCell align="center"><strong>Locations</strong></TableCell>
                <TableCell><strong>Created</strong></TableCell>
                <TableCell align="right"><strong>Actions</strong></TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {orgs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                    No organisations yet
                  </TableCell>
                </TableRow>
              )}
              {orgs.map(org => (
                <React.Fragment key={org.id}>
                  <TableRow hover sx={org.deleted_at ? { opacity: 0.55 } : undefined}>
                    <TableCell sx={{ width: 40 }}>
                      <IconButton aria-label="Expand details" size="small" onClick={() => handleToggleExpand(org.id)} disabled={!!org.deleted_at}>
                        {expandedOrg === org.id ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
                      </IconButton>
                    </TableCell>
                    <TableCell>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                        <Typography fontWeight={600}>{org.name}</Typography>
                        {org.deleted_at && (
                          <Chip label="DELETED" size="small" color="error" sx={{ fontSize: 10, height: 20 }} />
                        )}
                      </Box>
                      {org.deleted_at && (
                        <Typography variant="caption" color="text.secondary">
                          Soft-deleted {new Date(org.deleted_at).toLocaleString()} — purged 30d after
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <Chip label={org.slug} size="small" variant="outlined" sx={{ fontFamily: 'monospace' }} />
                    </TableCell>
                    <TableCell align="center">{org.user_count}</TableCell>
                    <TableCell align="center">{org.location_count}</TableCell>
                    <TableCell sx={{ color: 'text.secondary', fontSize: 13 }}>
                      {new Date(org.created_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                      {org.deleted_at ? (
                        <Button size="small" color="primary" onClick={() => handleRestoreOrg(org)}>
                          Restore
                        </Button>
                      ) : (
                        <>
                          <Button size="small" startIcon={<LinkIcon />} onClick={() => openInviteDialog(org.id)} sx={{ mr: 0.5 }}>
                            Invite
                          </Button>
                          <Tooltip title={org.id === '00000000-0000-0000-0000-000000000001' ? 'Default organisation cannot be deleted' : 'Delete organisation (30-day grace before permanent removal)'}>
                            <span>
                              <IconButton
                                aria-label="Delete"
                                size="small"
                                color="error"
                                onClick={() => openDeleteOrgDialog(org)}
                                disabled={org.id === '00000000-0000-0000-0000-000000000001'}
                              >
                                <DeleteIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                        </>
                      )}
                    </TableCell>
                  </TableRow>

                  {/* Expanded: users + invite tokens */}
                  <TableRow>
                    <TableCell colSpan={7} sx={{ py: 0, borderBottom: expandedOrg === org.id ? undefined : 'none' }}>
                      <Collapse in={expandedOrg === org.id} timeout="auto" unmountOnExit>
                        <Box sx={{ px: 4, py: 2 }}>

                          {/* ── Users ── */}
                          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                            <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>Users</Typography>
                            <Button size="small" startIcon={<AddIcon />} onClick={() => {
                              setAddUserForm({ email: '', name: '', role: 'viewer', password: '' });
                              setAddUserError('');
                              setAddUserOrgId(org.id);
                            }}>Add User</Button>
                          </Box>
                          {orgUsersLoading[org.id] ? (
                            <CircularProgress size={20} sx={{ ml: 1, mb: 1 }} />
                          ) : (orgUsers[org.id] ?? []).length === 0 ? (
                            <Typography variant="body2" color="text.disabled" sx={{ ml: 1, mb: 1 }}>No users yet.</Typography>
                          ) : (
                            <Table size="small" sx={{ mb: 1 }}>
                              <TableHead>
                                <TableRow>
                                  <TableCell>Name</TableCell>
                                  <TableCell>Email</TableCell>
                                  <TableCell>Role</TableCell>
                                  <TableCell align="right">Actions</TableCell>
                                </TableRow>
                              </TableHead>
                              <TableBody>
                                {(orgUsers[org.id] ?? []).map(u => (
                                  <TableRow key={u.id}>
                                    <TableCell>{u.name}</TableCell>
                                    <TableCell sx={{ color: 'text.secondary' }}>{u.email}</TableCell>
                                    <TableCell>
                                      <Chip label={u.role} size="small"
                                        color={u.role === 'admin' ? 'primary' : u.role === 'operator' ? 'warning' : 'default'} />
                                    </TableCell>
                                    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                                      <Tooltip title="Edit user">
                                        <IconButton aria-label="Edit" size="small" onClick={() => {
                                          setEditUserTarget(u);
                                          setEditUserForm({ name: u.name, email: u.email, role: u.role, newPassword: '' });
                                          setEditUserError('');
                                        }}>
                                          <EditIcon fontSize="small" />
                                        </IconButton>
                                      </Tooltip>
                                      <Tooltip title="Delete user">
                                        <IconButton aria-label="Delete" size="small" color="error" onClick={() => {
                                          setDeleteUserTarget(u);
                                          setDeleteUserOrgId(org.id);
                                        }}>
                                          <DeleteIcon fontSize="small" />
                                        </IconButton>
                                      </Tooltip>
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          )}

                          <Divider sx={{ my: 2 }} />

                          {/* ── Invite Tokens ── */}
                          <Typography variant="subtitle2" sx={{ mb: 1, color: 'text.secondary' }}>Invite Tokens</Typography>
                          {orgInvites(org.id).length === 0 ? (
                            <Typography variant="body2" color="text.secondary">No invites generated yet.</Typography>
                          ) : (
                            <List disablePadding>
                              {orgInvites(org.id).map(inv => {
                                const expired = isExpired(inv.expires_at);
                                const used = !!inv.used_at;
                                const status = used ? 'used' : expired ? 'expired' : 'active';
                                const inviteUrl = `${window.location.origin}/register?token=${inv.token}`;
                                return (
                                  <ListItem key={inv.id} disablePadding sx={{ py: 0.5 }}>
                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, width: '100%', flexWrap: 'wrap' }}>
                                      <Chip label={status} size="small"
                                        color={status === 'active' ? 'success' : status === 'used' ? 'default' : 'error'} />
                                      <Chip label={inv.role} size="small" variant="outlined" />
                                      {inv.email && <Typography variant="body2" color="text.secondary">{inv.email}</Typography>}
                                      <Typography variant="body2" color="text.secondary" sx={{ fontFamily: 'monospace', fontSize: 11 }}>
                                        {inv.token.slice(0, 16)}…
                                      </Typography>
                                      <Typography variant="body2" color="text.secondary" sx={{ fontSize: 12 }}>
                                        Expires {new Date(inv.expires_at).toLocaleDateString()}
                                      </Typography>
                                      {status === 'active' && (
                                        <Tooltip title="Copy invite link">
                                          <IconButton aria-label="Copy link" size="small" onClick={() => copyToClipboard(inviteUrl)}>
                                            <ContentCopyIcon fontSize="small" />
                                          </IconButton>
                                        </Tooltip>
                                      )}
                                    </Box>
                                  </ListItem>
                                );
                              })}
                            </List>
                          )}
                        </Box>
                      </Collapse>
                    </TableCell>
                  </TableRow>
                </React.Fragment>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Create Organisation Dialog */}
      <Dialog open={createOrgOpen} onClose={() => setCreateOrgOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>New Organisation</DialogTitle>
        <DialogContent>
          {orgError && <Alert severity="error" sx={{ mb: 2 }}>{orgError}</Alert>}
          <TextField
            autoFocus fullWidth label="Organisation Name" value={orgName}
            onChange={e => { setOrgName(e.target.value); setOrgSlugManual(false); }}
            sx={{ mt: 1, mb: 2 }} size="small"
            placeholder="e.g. Impi Events"
          />
          <TextField
            fullWidth label="URL Slug" value={orgSlug}
            onChange={e => { setOrgSlug(e.target.value); setOrgSlugManual(true); }}
            sx={{ mb: 1 }} size="small"
            helperText="Lowercase letters, numbers and hyphens only"
            placeholder="e.g. impi-events"
          />
          <TextField
            fullWidth label="Initial Admin Email (optional)" value={orgInviteEmail}
            onChange={e => setOrgInviteEmail(e.target.value)}
            sx={{ mb: 1 }} size="small"
            helperText="If set, the user will receive an onboarding email to create their account"
            placeholder="owner@company.com"
          />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => { setCreateOrgOpen(false); setOrgInviteEmail(''); }}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleCreateOrg}
            disabled={orgSaving || !orgName.trim() || !orgSlug.trim()}
          >
            {orgSaving ? 'Creating…' : 'Create Organisation'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Generate Invite Dialog */}
      <Dialog open={createInviteOpen} onClose={() => { setCreateInviteOpen(false); setGeneratedLink(null); }} maxWidth="sm" fullWidth>
        <DialogTitle>Generate Invite Link</DialogTitle>
        <DialogContent>
          {!generatedLink ? (
            <>
              {inviteError && <Alert severity="error" sx={{ mb: 2 }}>{inviteError}</Alert>}
              <FormControl fullWidth sx={{ mt: 1, mb: 2 }} size="small">
                <InputLabel>Organisation</InputLabel>
                <Select
                  value={inviteOrgId}
                  label="Organisation"
                  onChange={e => setInviteOrgId(e.target.value)}
                >
                  {orgs.map(o => (
                    <MenuItem key={o.id} value={o.id}>{o.name}</MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl fullWidth sx={{ mb: 2 }} size="small">
                <InputLabel>Role</InputLabel>
                <Select
                  value={inviteRole}
                  label="Role"
                  onChange={e => setInviteRole(e.target.value as any)}
                >
                  <MenuItem value="admin">Admin — full access, can manage users & locations</MenuItem>
                  <MenuItem value="operator">Operator — can manage locations & acknowledge alerts</MenuItem>
                  <MenuItem value="viewer">Viewer — read-only access</MenuItem>
                </Select>
              </FormControl>
              <TextField
                fullWidth label="Lock to specific email (optional)" value={inviteEmail}
                onChange={e => setInviteEmail(e.target.value)}
                size="small"
                helperText="If set, only this email address can use the invite"
                placeholder="user@company.com"
              />
            </>
          ) : (
            <Box sx={{ mt: 1 }}>
              <Alert severity="success" sx={{ mb: 2 }}>
                Invite {generatedLink.email_sent && generatedLink.email
                  ? <>sent to <strong>{generatedLink.email}</strong> for <strong>{generatedLink.org_name}</strong> ({generatedLink.role})</>
                  : <>link generated for <strong>{generatedLink.org_name}</strong> ({generatedLink.role})</>}
              </Alert>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                {generatedLink.email_sent && generatedLink.email
                  ? 'The signup email was delivered using the address above. You can also copy the backup invite link below:'
                  : 'Share this link with the new user — it expires in 7 days:'}
              </Typography>
              <Paper variant="outlined" sx={{ p: 1.5, display: 'flex', alignItems: 'center', gap: 1, bgcolor: 'background.default' }}>
                <Typography
                  variant="body2"
                  sx={{ fontFamily: 'monospace', fontSize: 12, flexGrow: 1, wordBreak: 'break-all' }}
                >
                  {generatedLink.url}
                </Typography>
                <Tooltip title="Copy link">
                  <IconButton aria-label="Copy link" size="small" onClick={() => copyToClipboard(generatedLink.url)}>
                    <ContentCopyIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Paper>
            </Box>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => { setCreateInviteOpen(false); setGeneratedLink(null); }}>
            {generatedLink ? 'Close' : 'Cancel'}
          </Button>
          {!generatedLink && (
            <Button
              variant="contained"
              startIcon={<SendIcon />}
              onClick={handleCreateInvite}
              disabled={inviteSaving || !inviteOrgId}
            >
              {inviteSaving ? (inviteEmail.trim() ? 'Sending…' : 'Generating…') : (inviteEmail.trim() ? 'Send Invite' : 'Generate Link')}
            </Button>
          )}
          {generatedLink && (
            <Button
              variant="contained"
              startIcon={<LinkIcon />}
              onClick={() => { setGeneratedLink(null); }}
            >
              Generate Another
            </Button>
          )}
        </DialogActions>
      </Dialog>

      {/* Add User Dialog */}
      <Dialog open={!!addUserOrgId} onClose={() => setAddUserOrgId(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Add User to {orgs.find(o => o.id === addUserOrgId)?.name}</DialogTitle>
        <DialogContent>
          {addUserError && <Alert severity="error" sx={{ mb: 2 }}>{addUserError}</Alert>}
          <TextField autoFocus fullWidth label="Name" value={addUserForm.name}
            onChange={e => setAddUserForm(f => ({ ...f, name: e.target.value }))}
            sx={{ mt: 1, mb: 2 }} size="small" />
          <TextField fullWidth label="Email" type="email" value={addUserForm.email}
            onChange={e => setAddUserForm(f => ({ ...f, email: e.target.value }))}
            sx={{ mb: 2 }} size="small" />
          <TextField fullWidth label="Password" type="password" value={addUserForm.password}
            onChange={e => setAddUserForm(f => ({ ...f, password: e.target.value }))}
            sx={{ mb: 2 }} size="small" helperText="Minimum 6 characters" />
          <FormControl fullWidth size="small">
            <InputLabel>Role</InputLabel>
            <Select value={addUserForm.role} label="Role"
              onChange={e => setAddUserForm(f => ({ ...f, role: e.target.value as any }))}>
              <MenuItem value="admin">Admin</MenuItem>
              <MenuItem value="operator">Operator</MenuItem>
              <MenuItem value="viewer">Viewer</MenuItem>
            </Select>
          </FormControl>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setAddUserOrgId(null)}>Cancel</Button>
          <Button variant="contained" onClick={handleAddUser}
            disabled={addUserSaving || !addUserForm.email || !addUserForm.name || addUserForm.password.length < 6}>
            {addUserSaving ? 'Adding…' : 'Add User'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Edit User Dialog */}
      <Dialog open={!!editUserTarget} onClose={() => setEditUserTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Edit User</DialogTitle>
        <DialogContent>
          {editUserError && <Alert severity="error" sx={{ mb: 2 }}>{editUserError}</Alert>}
          <TextField autoFocus fullWidth label="Name" value={editUserForm.name}
            onChange={e => setEditUserForm(f => ({ ...f, name: e.target.value }))}
            sx={{ mt: 1, mb: 2 }} size="small" />
          <TextField fullWidth label="Email" type="email" value={editUserForm.email}
            onChange={e => setEditUserForm(f => ({ ...f, email: e.target.value }))}
            sx={{ mb: 2 }} size="small" />
          <FormControl fullWidth size="small" sx={{ mb: 2 }}>
            <InputLabel>Role</InputLabel>
            <Select value={editUserForm.role} label="Role"
              onChange={e => setEditUserForm(f => ({ ...f, role: e.target.value as any }))}>
              <MenuItem value="admin">Admin</MenuItem>
              <MenuItem value="operator">Operator</MenuItem>
              <MenuItem value="viewer">Viewer</MenuItem>
            </Select>
          </FormControl>
          <TextField fullWidth label="New Password (leave blank to keep)" type="password" value={editUserForm.newPassword}
            onChange={e => setEditUserForm(f => ({ ...f, newPassword: e.target.value }))}
            size="small" helperText="Only fill in if you want to change the password" />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setEditUserTarget(null)}>Cancel</Button>
          <Button variant="contained" onClick={handleEditUser}
            disabled={editUserSaving || !editUserForm.email || !editUserForm.name}>
            {editUserSaving ? 'Saving…' : 'Save Changes'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete User Dialog */}
      <Dialog open={!!deleteUserTarget} onClose={() => { setDeleteUserTarget(null); setDeleteUserOrgId(null); }} maxWidth="xs" fullWidth>
        <DialogTitle>Delete User</DialogTitle>
        <DialogContent>
          <Alert severity="warning">
            Permanently delete <strong>{deleteUserTarget?.name}</strong> ({deleteUserTarget?.email})? This cannot be undone.
          </Alert>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => { setDeleteUserTarget(null); setDeleteUserOrgId(null); }}>Cancel</Button>
          <Button variant="contained" color="error" onClick={handleDeleteUser} disabled={deleteUserSaving}>
            {deleteUserSaving ? 'Deleting…' : 'Delete User'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete Organisation Dialog */}
      <Dialog open={deleteOrgOpen} onClose={() => setDeleteOrgOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Delete Organisation</DialogTitle>
        <DialogContent>
          <Alert severity="error" sx={{ mb: 2 }}>
            This will permanently delete <strong>{orgToDelete?.name}</strong> and all associated data:
            <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
              <li>{orgToDelete?.user_count} user{orgToDelete?.user_count !== 1 ? 's' : ''}</li>
              <li>{orgToDelete?.location_count} location{orgToDelete?.location_count !== 1 ? 's' : ''} (with all alerts &amp; risk history)</li>
              <li>All pending invite tokens</li>
            </ul>
          </Alert>
          <Typography variant="body2" sx={{ mb: 2 }}>
            Type <strong>{orgToDelete?.name}</strong> to confirm:
          </Typography>
          <TextField
            autoFocus
            fullWidth
            size="small"
            placeholder={orgToDelete?.name}
            value={deleteOrgConfirmName}
            onChange={e => setDeleteOrgConfirmName(e.target.value)}
          />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDeleteOrgOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            color="error"
            startIcon={<DeleteIcon />}
            onClick={handleDeleteOrg}
            disabled={deleteOrgSaving || deleteOrgConfirmName !== orgToDelete?.name}
          >
            {deleteOrgSaving ? 'Deleting…' : 'Delete Organisation'}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={!!snack}
        autoHideDuration={4000}
        onClose={() => setSnack('')}
        message={snack}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Box>
  );
}

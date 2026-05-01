import React, { useState, useEffect, useCallback } from 'react';
import {
  Box, Typography, Paper, Button, TextField, Dialog, DialogTitle,
  DialogContent, DialogActions, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, Chip, IconButton, Alert, Tooltip, Skeleton,
  Divider, CircularProgress, Select, MenuItem, FormControl, InputLabel,
  Collapse, List, ListItem, ListItemText, useMediaQuery, useTheme,
} from '@mui/material';
import EmptyState from './components/EmptyState';
import AddIcon from '@mui/icons-material/Add';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import LinkIcon from '@mui/icons-material/Link';
import BusinessIcon from '@mui/icons-material/Business';
import SendIcon from '@mui/icons-material/Send';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import api, { revokeInvite } from './api';
import { useToast } from './components/ToastProvider';
import { useOrgScope } from './OrgScope';
import { AddUserDialog, EditUserDialog, DeleteUserDialog, type UserRow } from './components/UserDialogs';

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

type OrgUser = UserRow & { created_at: string };

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

// Canonical UUID of the default platform tenant (FlashAware itself). Server
// hard-codes this and forbids deletion; UI surfaces it as a badge so super
// admins understand why it can't be removed and treat writes against it
// accordingly.
const PLATFORM_ORG_ID = '00000000-0000-0000-0000-000000000001';

export default function OrgManagement() {
  const toast = useToast();
  const theme = useTheme();
  // Long form-heavy dialogs (create org, generate invite, delete confirmation)
  // are easier to use full-screen on a phone — the keyboard otherwise eats half
  // the dialog and the action buttons fall behind it.
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const { scopedOrgId } = useOrgScope();
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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

  // Expanded org rows (showing their invites). Multiple orgs can be expanded
  // at once so super_admin can compare two tenants without losing their place.
  const [expandedOrgs, setExpandedOrgs] = useState<Set<string>>(new Set());
  const isExpanded = (id: string) => expandedOrgs.has(id);

  // Delete org dialog
  const [deleteOrgOpen, setDeleteOrgOpen] = useState(false);
  const [orgToDelete, setOrgToDelete] = useState<Org | null>(null);
  const [deleteOrgConfirmName, setDeleteOrgConfirmName] = useState('');
  const [deleteOrgSaving, setDeleteOrgSaving] = useState(false);

  // Per-org users (loaded on expand)
  const [orgUsers, setOrgUsers] = useState<Record<string, OrgUser[]>>({});
  const [orgUsersLoading, setOrgUsersLoading] = useState<Record<string, boolean>>({});

  // Add user dialog — orgId both opens the dialog and tells the create call
  // which tenant to put the user in.
  const [addUserOrgId, setAddUserOrgId] = useState<string | null>(null);

  // Edit / Delete user dialogs — track the target plus the org so we know
  // which expanded section to refresh on save / delete.
  const [editUserTarget, setEditUserTarget] = useState<OrgUser | null>(null);
  const [editUserOrgId, setEditUserOrgId] = useState<string | null>(null);
  const [deleteUserTarget, setDeleteUserTarget] = useState<OrgUser | null>(null);
  const [deleteUserOrgId, setDeleteUserOrgId] = useState<string | null>(null);

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
    const wasExpanded = expandedOrgs.has(orgId);
    setExpandedOrgs(prev => {
      const next = new Set(prev);
      if (wasExpanded) next.delete(orgId);
      else next.add(orgId);
      return next;
    });
    // Re-fetch users every time the panel opens. Previously we cached the
    // first result indefinitely — if the very first load returned [] (auth
    // race, transient 5xx, or pre-invite-acceptance state), the panel was
    // stuck on "No users yet" even after the row count climbed to N. Always
    // reloading on open keeps the panel honest against the row count.
    if (!wasExpanded) {
      await loadOrgUsers(orgId);
    }
  };

  const handleRevokeInvite = async (inviteId: string) => {
    try {
      await revokeInvite(inviteId);
      toast.success('Invite revoked');
      loadAll();
    } catch (e: any) {
      toast.error(e.response?.data?.error || 'Failed to revoke invite');
    }
  };

  // Refresh callbacks for the shared user dialogs. Each writes through the
  // same /users API the dialogs use; we just need to refresh the local view
  // (the expanded org's user list) and the org-row counts.
  const onUserCreated = async () => {
    if (addUserOrgId) await loadOrgUsers(addUserOrgId);
    loadAll();
  };
  const onUserSaved = async () => {
    if (editUserOrgId) await loadOrgUsers(editUserOrgId);
  };
  const onUserDeleted = async () => {
    if (deleteUserOrgId) await loadOrgUsers(deleteUserOrgId);
    loadAll();
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
      toast.success(
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
      toast.success(`Organisation "${orgToDelete.name}" deleted. Data preserved for 30 days; restore until then or it will be permanently removed.`);
      setDeleteOrgOpen(false);
      setOrgToDelete(null);
      loadAll();
    } catch (e: any) {
      toast.error(e.response?.data?.error || 'Failed to delete organisation');
      setDeleteOrgOpen(false);
    } finally {
      setDeleteOrgSaving(false);
    }
  };

  const handleRestoreOrg = async (org: Org) => {
    try {
      await api.post(`/orgs/${org.id}/restore`);
      toast.success(`Organisation "${org.name}" restored`);
      loadAll();
    } catch (e: any) {
      toast.error(e.response?.data?.error || 'Failed to restore organisation');
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

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied to clipboard');
    } catch {
      // Fires when the page isn't on https/localhost or the user denies permission
      toast.error('Copy failed — your browser blocked clipboard access');
    }
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
          <Button variant="outlined" startIcon={<LinkIcon />} onClick={() => {
            // Default to the active org scope if the picker is set; otherwise
            // leave empty so the super_admin must consciously pick. Previously
            // we preselected orgs[0], which made one wrong click send an invite
            // to whichever org happened to be alphabetically first.
            setInviteOrgId(scopedOrgId || '');
            setInviteRole('viewer');
            setInviteEmail('');
            setInviteError('');
            setGeneratedLink(null);
            setCreateInviteOpen(true);
          }}>
            Generate Invite
          </Button>
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => { setCreateOrgOpen(true); setOrgName(''); setOrgSlug(''); setOrgSlugManual(false); setOrgInviteEmail(''); setOrgError(''); }}>
            New Organisation
          </Button>
        </Box>
      </Box>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {loading ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {[0, 1, 2].map(i => <Skeleton key={i} variant="rounded" height={56} />)}
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
                  <TableCell colSpan={7} sx={{ py: 4 }}>
                    <EmptyState
                      icon={<BusinessIcon />}
                      title="No organisations yet"
                      description="Create your first tenant to onboard a customer."
                      cta={{ label: 'New Organisation', icon: <AddIcon />, onClick: () => { setCreateOrgOpen(true); setOrgName(''); setOrgSlug(''); setOrgSlugManual(false); setOrgInviteEmail(''); setOrgError(''); } }}
                    />
                  </TableCell>
                </TableRow>
              )}
              {orgs.map(org => (
                <React.Fragment key={org.id}>
                  <TableRow hover sx={org.deleted_at ? { opacity: 0.55 } : undefined}>
                    <TableCell sx={{ width: 40 }}>
                      <IconButton aria-label="Expand details" size="small" onClick={() => handleToggleExpand(org.id)} disabled={!!org.deleted_at}>
                        {isExpanded(org.id) ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
                      </IconButton>
                    </TableCell>
                    <TableCell>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                        <Typography fontWeight={600}>{org.name}</Typography>
                        {org.id === PLATFORM_ORG_ID && (
                          <Tooltip title="Default platform tenant — cannot be deleted">
                            <Chip label="PLATFORM" size="small" color="primary" variant="outlined" sx={{ fontSize: 10, height: 20 }} />
                          </Tooltip>
                        )}
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
                          <Tooltip title={org.id === PLATFORM_ORG_ID ? 'Default organisation cannot be deleted' : 'Delete organisation (30-day grace before permanent removal)'}>
                            <span>
                              <IconButton
                                aria-label="Delete"
                                size="small"
                                color="error"
                                onClick={() => openDeleteOrgDialog(org)}
                                disabled={org.id === PLATFORM_ORG_ID}
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
                    <TableCell colSpan={7} sx={{ py: 0, borderBottom: isExpanded(org.id) ? undefined : 'none' }}>
                      <Collapse in={isExpanded(org.id)} timeout="auto" unmountOnExit>
                        {/* Reduce horizontal indent on phones — px:4 = 32px each side
                            costs us ~64px on a 360px viewport, enough to push the
                            users/invites tables into horizontal-scroll territory. */}
                        <Box sx={{ px: { xs: 1.5, sm: 4 }, py: 2 }}>

                          {/* ── Users ── */}
                          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                            <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>Users</Typography>
                            <Button size="small" startIcon={<AddIcon />} onClick={() => setAddUserOrgId(org.id)}>Add User</Button>
                          </Box>
                          {orgUsersLoading[org.id] ? (
                            <CircularProgress size={20} sx={{ ml: 1, mb: 1 }} />
                          ) : (orgUsers[org.id] ?? []).length === 0 ? (
                            <Typography variant="body2" color="text.disabled" sx={{ ml: 1, mb: 1 }}>No users yet.</Typography>
                          ) : (
                            <TableContainer sx={{ mb: 1 }}>
                            <Table size="small">
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
                                          setEditUserOrgId(org.id);
                                          setEditUserTarget(u);
                                        }}>
                                          <EditIcon fontSize="small" />
                                        </IconButton>
                                      </Tooltip>
                                      <Tooltip title="Delete user">
                                        <IconButton aria-label="Delete" size="small" color="error" onClick={() => {
                                          setDeleteUserOrgId(org.id);
                                          setDeleteUserTarget(u);
                                        }}>
                                          <DeleteIcon fontSize="small" />
                                        </IconButton>
                                      </Tooltip>
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                            </TableContainer>
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
                                        <>
                                          <Tooltip title="Copy invite link">
                                            <IconButton aria-label="Copy link" size="small" onClick={() => copyToClipboard(inviteUrl)}>
                                              <ContentCopyIcon fontSize="small" />
                                            </IconButton>
                                          </Tooltip>
                                          <Tooltip title="Revoke this invite — the link will stop working immediately">
                                            <IconButton aria-label="Revoke invite" size="small" color="error" onClick={() => handleRevokeInvite(inv.id)}>
                                              <DeleteIcon fontSize="small" />
                                            </IconButton>
                                          </Tooltip>
                                        </>
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
      <Dialog open={createOrgOpen} onClose={() => setCreateOrgOpen(false)} maxWidth="sm" fullWidth fullScreen={isMobile}>
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
      <Dialog open={createInviteOpen} onClose={() => { setCreateInviteOpen(false); setGeneratedLink(null); }} maxWidth="sm" fullWidth fullScreen={isMobile}>
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

      <AddUserDialog
        open={!!addUserOrgId}
        onClose={() => setAddUserOrgId(null)}
        onCreated={onUserCreated}
        orgId={addUserOrgId ?? undefined}
        orgName={orgs.find(o => o.id === addUserOrgId)?.name}
      />

      <EditUserDialog
        target={editUserTarget}
        onClose={() => { setEditUserTarget(null); setEditUserOrgId(null); }}
        onSaved={onUserSaved}
      />

      <DeleteUserDialog
        target={deleteUserTarget}
        onClose={() => { setDeleteUserTarget(null); setDeleteUserOrgId(null); }}
        onDeleted={onUserDeleted}
      />

      {/* Delete Organisation Dialog */}
      <Dialog open={deleteOrgOpen} onClose={() => setDeleteOrgOpen(false)} maxWidth="sm" fullWidth fullScreen={isMobile}>
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

    </Box>
  );
}

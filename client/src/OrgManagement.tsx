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
import api from './api';

interface Org {
  id: string;
  name: string;
  slug: string;
  created_at: string;
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
  const [orgSaving, setOrgSaving] = useState(false);
  const [orgError, setOrgError] = useState('');

  // Create invite dialog
  const [createInviteOpen, setCreateInviteOpen] = useState(false);
  const [inviteOrgId, setInviteOrgId] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'operator' | 'viewer'>('viewer');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteSaving, setInviteSaving] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [generatedLink, setGeneratedLink] = useState<{ url: string; org_name: string; role: string } | null>(null);

  // Expanded org rows (showing their invites)
  const [expandedOrg, setExpandedOrg] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [orgsRes, invitesRes] = await Promise.all([
        api.get('/orgs'),
        api.get('/orgs/invites'),
      ]);
      setOrgs(orgsRes.data);
      setInvites(invitesRes.data);
    } catch (e: any) {
      setError(e.response?.data?.error || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Auto-generate slug from name
  useEffect(() => {
    if (!orgSlugManual) setOrgSlug(slugify(orgName));
  }, [orgName, orgSlugManual]);

  const handleCreateOrg = async () => {
    setOrgSaving(true);
    setOrgError('');
    try {
      await api.post('/orgs', { name: orgName.trim(), slug: orgSlug.trim() });
      setSnack(`Organisation "${orgName}" created`);
      setCreateOrgOpen(false);
      setOrgName('');
      setOrgSlug('');
      setOrgSlugManual(false);
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
      const res = await api.post('/orgs/invites', body);
      setGeneratedLink({ url: res.data.invite_url, org_name: res.data.org_name, role: res.data.role });
      setInviteEmail('');
      loadAll();
    } catch (e: any) {
      setInviteError(e.response?.data?.error || 'Failed to create invite');
    } finally {
      setInviteSaving(false);
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
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button variant="outlined" startIcon={<LinkIcon />} onClick={() => { setInviteOrgId(orgs[0]?.id || ''); setInviteRole('viewer'); setInviteEmail(''); setInviteError(''); setGeneratedLink(null); setCreateInviteOpen(true); }}>
            Generate Invite
          </Button>
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => { setCreateOrgOpen(true); setOrgName(''); setOrgSlug(''); setOrgSlugManual(false); setOrgError(''); }}>
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
                  <TableRow hover>
                    <TableCell sx={{ width: 40 }}>
                      <IconButton size="small" onClick={() => setExpandedOrg(expandedOrg === org.id ? null : org.id)}>
                        {expandedOrg === org.id ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
                      </IconButton>
                    </TableCell>
                    <TableCell>
                      <Typography fontWeight={600}>{org.name}</Typography>
                    </TableCell>
                    <TableCell>
                      <Chip label={org.slug} size="small" variant="outlined" sx={{ fontFamily: 'monospace' }} />
                    </TableCell>
                    <TableCell align="center">{org.user_count}</TableCell>
                    <TableCell align="center">{org.location_count}</TableCell>
                    <TableCell sx={{ color: 'text.secondary', fontSize: 13 }}>
                      {new Date(org.created_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell align="right">
                      <Button size="small" startIcon={<LinkIcon />} onClick={() => openInviteDialog(org.id)}>
                        Invite
                      </Button>
                    </TableCell>
                  </TableRow>

                  {/* Expanded invite list */}
                  <TableRow>
                    <TableCell colSpan={7} sx={{ py: 0, borderBottom: expandedOrg === org.id ? undefined : 'none' }}>
                      <Collapse in={expandedOrg === org.id} timeout="auto" unmountOnExit>
                        <Box sx={{ px: 4, py: 2 }}>
                          <Typography variant="subtitle2" sx={{ mb: 1, color: 'text.secondary' }}>
                            Invite Tokens
                          </Typography>
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
                                      <Chip
                                        label={status}
                                        size="small"
                                        color={status === 'active' ? 'success' : status === 'used' ? 'default' : 'error'}
                                      />
                                      <Chip label={inv.role} size="small" variant="outlined" />
                                      {inv.email && (
                                        <Typography variant="body2" color="text.secondary">{inv.email}</Typography>
                                      )}
                                      <Typography variant="body2" color="text.secondary" sx={{ fontFamily: 'monospace', fontSize: 11 }}>
                                        {inv.token.slice(0, 16)}…
                                      </Typography>
                                      <Typography variant="body2" color="text.secondary" sx={{ fontSize: 12 }}>
                                        Expires {new Date(inv.expires_at).toLocaleDateString()}
                                      </Typography>
                                      {status === 'active' && (
                                        <Tooltip title="Copy invite link">
                                          <IconButton size="small" onClick={() => copyToClipboard(inviteUrl)}>
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
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setCreateOrgOpen(false)}>Cancel</Button>
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
                Invite link generated for <strong>{generatedLink.org_name}</strong> ({generatedLink.role})
              </Alert>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                Share this link with the new user — it expires in 7 days:
              </Typography>
              <Paper variant="outlined" sx={{ p: 1.5, display: 'flex', alignItems: 'center', gap: 1, bgcolor: 'background.default' }}>
                <Typography
                  variant="body2"
                  sx={{ fontFamily: 'monospace', fontSize: 12, flexGrow: 1, wordBreak: 'break-all' }}
                >
                  {generatedLink.url}
                </Typography>
                <Tooltip title="Copy link">
                  <IconButton size="small" onClick={() => copyToClipboard(generatedLink.url)}>
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
              {inviteSaving ? 'Generating…' : 'Generate Link'}
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

      <Snackbar
        open={!!snack}
        autoHideDuration={3000}
        onClose={() => setSnack('')}
        message={snack}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Box>
  );
}

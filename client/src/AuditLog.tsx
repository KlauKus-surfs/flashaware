import React, { useState, useEffect, useCallback } from 'react';
import {
  Box, Card, CardContent, Typography, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, Paper, TablePagination, TextField, MenuItem, Chip,
  IconButton, Collapse, Stack, Tooltip,
} from '@mui/material';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import RefreshIcon from '@mui/icons-material/Refresh';
import { DateTime } from 'luxon';
import { getAuditLog } from './api';
import { useCurrentUser } from './App';
import { useOrgScope } from './OrgScope';

interface AuditRow {
  id: number;
  actor_user_id: string | null;
  actor_email: string;
  actor_role: string;
  action: string;
  target_type: string;
  target_id: string | null;
  target_org_id: string | null;
  before: any;
  after: any;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  org_name: string | null;
}

const ACTION_CATEGORIES = [
  { value: '', label: 'All actions' },
  { value: 'location.', label: 'Locations' },
  { value: 'recipient.', label: 'Recipients' },
  { value: 'org.', label: 'Organisations' },
  { value: 'user.', label: 'Users' },
  { value: 'invite.', label: 'Invites' },
  { value: 'settings.', label: 'Settings' },
  { value: 'platform_settings.', label: 'Platform settings' },
  { value: 'alert.', label: 'Alerts' },
];

function actionColor(action: string): 'default' | 'success' | 'warning' | 'error' | 'info' | 'primary' {
  if (action.endsWith('.delete')) return 'error';
  if (action.endsWith('.create')) return 'success';
  if (action.endsWith('.update')) return 'info';
  if (action === 'user.login') return 'default';
  if (action === 'recipient.phone_verify') return 'success';
  if (action === 'recipient.otp_send') return 'warning';
  return 'primary';
}

function fmtDate(s: string): string {
  return DateTime.fromISO(s, { zone: 'utc' }).setZone('Africa/Johannesburg').toFormat('yyyy-MM-dd HH:mm:ss');
}

function ExpandRow({ row, onActorClick, onTargetClick }: {
  row: AuditRow;
  onActorClick: (email: string) => void;
  onTargetClick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const hasDetail = row.before || row.after;
  return (
    <>
      <TableRow hover>
        <TableCell sx={{ width: 32 }}>
          {hasDetail && (
            <IconButton aria-label="Expand details" size="small" onClick={() => setOpen(o => !o)}>
              {open ? <KeyboardArrowUpIcon fontSize="small" /> : <KeyboardArrowDownIcon fontSize="small" />}
            </IconButton>
          )}
        </TableCell>
        <TableCell sx={{ fontSize: 12, whiteSpace: 'nowrap' }}>{fmtDate(row.created_at)}</TableCell>
        <TableCell sx={{ fontSize: 12 }}>
          <Box
            onClick={() => onActorClick(row.actor_email)}
            sx={{ cursor: 'pointer', '&:hover': { textDecoration: 'underline' } }}
            role="button"
            tabIndex={0}
            aria-label={`Filter by ${row.actor_email}`}
          >
            <Typography variant="body2" fontWeight={500} sx={{ fontSize: 12 }}>{row.actor_email}</Typography>
            <Typography variant="caption" color="text.secondary">{row.actor_role}</Typography>
          </Box>
        </TableCell>
        <TableCell>
          <Chip label={row.action} size="small" color={actionColor(row.action)} sx={{ fontSize: 11, height: 22 }} />
        </TableCell>
        <TableCell sx={{ fontSize: 12 }}>{row.target_type}</TableCell>
        <TableCell sx={{ fontSize: 11, color: 'text.secondary' }}>
          <Tooltip title={row.target_id || ''}>
            <Box
              onClick={() => { if (row.target_id) { onTargetClick(row.target_id); } }}
              sx={{ cursor: row.target_id ? 'pointer' : 'default', '&:hover': row.target_id ? { textDecoration: 'underline' } : {} }}
              component="span"
            >
              {row.target_id ? row.target_id.slice(0, 12) + (row.target_id.length > 12 ? '…' : '') : '—'}
            </Box>
          </Tooltip>
        </TableCell>
        <TableCell sx={{ fontSize: 12 }}>{row.org_name || '—'}</TableCell>
        <TableCell sx={{ fontSize: 11, color: 'text.secondary' }}>{row.ip || '—'}</TableCell>
      </TableRow>
      {hasDetail && (
        <TableRow>
          <TableCell sx={{ p: 0, borderBottom: open ? undefined : 'none' }} colSpan={8}>
            <Collapse in={open} timeout="auto" unmountOnExit>
              <Box sx={{ p: 2, bgcolor: 'rgba(255,255,255,0.03)' }}>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                  {row.before && (
                    <Box sx={{ flex: 1 }}>
                      <Typography variant="caption" color="text.secondary">Before</Typography>
                      <Paper variant="outlined" sx={{ p: 1, bgcolor: 'rgba(0,0,0,0.2)' }}>
                        <pre style={{ margin: 0, fontSize: 11, overflowX: 'auto' }}>{JSON.stringify(row.before, null, 2)}</pre>
                      </Paper>
                    </Box>
                  )}
                  {row.after && (
                    <Box sx={{ flex: 1 }}>
                      <Typography variant="caption" color="text.secondary">After</Typography>
                      <Paper variant="outlined" sx={{ p: 1, bgcolor: 'rgba(0,0,0,0.2)' }}>
                        <pre style={{ margin: 0, fontSize: 11, overflowX: 'auto' }}>{JSON.stringify(row.after, null, 2)}</pre>
                      </Paper>
                    </Box>
                  )}
                </Stack>
                {row.user_agent && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                    UA: {row.user_agent}
                  </Typography>
                )}
              </Box>
            </Collapse>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export default function AuditLog() {
  const user = useCurrentUser();
  const { scopedOrgId } = useOrgScope();
  const isSuperAdmin = user?.role === 'super_admin';

  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(50);
  const [actionPrefix, setActionPrefix] = useState('');
  const [actorEmail, setActorEmail] = useState('');
  const [targetId, setTargetId] = useState('');
  const [since, setSince] = useState('');     // YYYY-MM-DDTHH:mm
  const [until, setUntil] = useState('');

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const filters: any = {
        limit: rowsPerPage,
        offset: page * rowsPerPage,
      };
      if (actionPrefix) filters.action_prefix = actionPrefix;
      if (isSuperAdmin && scopedOrgId) filters.org_id = scopedOrgId;
      if (actorEmail.trim()) filters.actor_email = actorEmail.trim();
      if (targetId.trim()) filters.target_id = targetId.trim();
      if (since) filters.since = new Date(since).toISOString();
      if (until) filters.until = new Date(until).toISOString();
      const res = await getAuditLog(filters);
      setRows(res.data);
    } catch (err) {
      console.error('Failed to load audit log', err);
    } finally {
      setLoading(false);
    }
  }, [page, rowsPerPage, actionPrefix, isSuperAdmin, scopedOrgId, actorEmail, targetId, since, until]);

  useEffect(() => { fetchRows(); }, [fetchRows]);

  return (
    <Box>
      <Typography variant="h4" sx={{ mb: 2 }}>Audit Log</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        {isSuperAdmin
          ? 'Every mutation across the platform — view all orgs or use the picker in the top bar to filter.'
          : 'Every change made by users in your organisation.'}
      </Typography>

      <Card sx={{ mb: 2 }}>
        <CardContent sx={{ '&:last-child': { pb: 2 } }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <TextField
              select
              label="Filter by action"
              value={actionPrefix}
              onChange={e => { setActionPrefix(e.target.value); setPage(0); }}
              size="small"
              sx={{ minWidth: 200 }}
            >
              {ACTION_CATEGORIES.map(c => <MenuItem key={c.value} value={c.value}>{c.label}</MenuItem>)}
            </TextField>
            <TextField
              label="Actor email contains"
              value={actorEmail}
              onChange={e => { setActorEmail(e.target.value); setPage(0); }}
              size="small"
              sx={{ minWidth: 200 }}
            />
            <TextField
              label="Target ID"
              value={targetId}
              onChange={e => { setTargetId(e.target.value); setPage(0); }}
              size="small"
              sx={{ minWidth: 200 }}
              placeholder="Paste a UUID"
            />
            <TextField
              label="From"
              type="datetime-local"
              value={since}
              onChange={e => { setSince(e.target.value); setPage(0); }}
              size="small"
              InputLabelProps={{ shrink: true }}
              sx={{ minWidth: 200 }}
            />
            <TextField
              label="To"
              type="datetime-local"
              value={until}
              onChange={e => { setUntil(e.target.value); setPage(0); }}
              size="small"
              InputLabelProps={{ shrink: true }}
              sx={{ minWidth: 200 }}
            />
            <Box sx={{ flex: 1 }} />
            <IconButton aria-label="Refresh" onClick={fetchRows} disabled={loading}><RefreshIcon /></IconButton>
          </Stack>
        </CardContent>
      </Card>

      <TableContainer component={Paper}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={{ width: 32 }} />
              <TableCell>When</TableCell>
              <TableCell>Actor</TableCell>
              <TableCell>Action</TableCell>
              <TableCell>Target</TableCell>
              <TableCell>Target ID</TableCell>
              <TableCell>Org</TableCell>
              <TableCell>IP</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} sx={{ textAlign: 'center', py: 4, color: 'text.secondary' }}>
                  {loading ? 'Loading…' : 'No audit entries match these filters.'}
                </TableCell>
              </TableRow>
            ) : rows.map(r => (
              <ExpandRow
                key={r.id}
                row={r}
                onActorClick={(e) => { setActorEmail(e); setPage(0); }}
                onTargetClick={(t) => { setTargetId(t); setPage(0); }}
              />
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <TablePagination
        component="div"
        count={-1}
        page={page}
        onPageChange={(_, p) => setPage(p)}
        rowsPerPage={rowsPerPage}
        rowsPerPageOptions={[25, 50, 100, 200]}
        onRowsPerPageChange={e => { setRowsPerPage(parseInt(e.target.value, 10)); setPage(0); }}
        labelDisplayedRows={({ from, to }) => `${from}–${to}`}
      />
    </Box>
  );
}

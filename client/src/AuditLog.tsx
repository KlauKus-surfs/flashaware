import React, { useState, useEffect, useCallback } from 'react';
import {
  Box, Card, CardContent, Typography, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, Paper, TablePagination, TextField, MenuItem, Chip,
  IconButton, Collapse, Stack, Tooltip, Button, useTheme, useMediaQuery,
} from '@mui/material';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import RefreshIcon from '@mui/icons-material/Refresh';
import DownloadIcon from '@mui/icons-material/Download';
import { DateTime } from 'luxon';
import { Alert } from '@mui/material';
import { getAuditLog } from './api';
import { useCurrentUser } from './App';
import { useOrgScope } from './OrgScope';
import JsonDiff from './components/JsonDiff';
import { formatSAST } from './utils/format';

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

const fmtDate = (s: string) => formatSAST(s, 'full');

// Mobile equivalent of ExpandRow — same expand/collapse behaviour, same diff
// view. Without this, mobile auditors can only see the summary chips and lose
// the before/after that's the whole point of the page.
function MobileAuditCard({ row }: { row: AuditRow }) {
  const [open, setOpen] = useState(false);
  const hasDetail = row.before || row.after;
  return (
    <Card variant="outlined">
      <CardContent sx={{ py: 1.25, '&:last-child': { pb: 1.25 } }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, mb: 0.5, flexWrap: 'wrap' }}>
          <Chip label={row.action} size="small" color={actionColor(row.action)} sx={{ fontSize: 11, height: 22 }} />
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
            {fmtDate(row.created_at)}
          </Typography>
        </Box>
        <Typography variant="body2" fontWeight={600}>{row.actor_email}</Typography>
        <Typography variant="caption" color="text.secondary">{row.actor_role}</Typography>
        <Box sx={{ mt: 0.5, display: 'flex', gap: 0.5, flexWrap: 'wrap', alignItems: 'center' }}>
          <Typography variant="caption" color="text.secondary">{row.target_type}</Typography>
          {row.target_id && (
            <Typography variant="caption" sx={{ fontFamily: 'monospace', fontSize: 10, color: 'text.secondary' }}>
              · {row.target_id.slice(0, 12)}…
            </Typography>
          )}
          {row.org_name && (
            <Typography variant="caption" color="text.secondary">· {row.org_name}</Typography>
          )}
        </Box>
        {hasDetail && (
          <>
            <Button
              size="small"
              variant="text"
              startIcon={open ? <KeyboardArrowUpIcon fontSize="small" /> : <KeyboardArrowDownIcon fontSize="small" />}
              onClick={() => setOpen(o => !o)}
              sx={{ mt: 0.5, fontSize: 11, py: 0, px: 0.5, minWidth: 0 }}
              aria-label={open ? 'Hide details' : 'Show details'}
            >
              {open ? 'Hide details' : 'Show details'}
            </Button>
            <Collapse in={open} timeout="auto" unmountOnExit>
              <Box sx={{ mt: 1, p: 1, bgcolor: 'rgba(255,255,255,0.03)', borderRadius: 1 }}>
                <JsonDiff before={row.before} after={row.after} />
                {row.user_agent && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1, wordBreak: 'break-all' }}>
                    UA: {row.user_agent}
                  </Typography>
                )}
              </Box>
            </Collapse>
          </>
        )}
      </CardContent>
    </Card>
  );
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
                <JsonDiff before={row.before} after={row.after} />
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

  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  const exportCsv = () => {
    const headers = ['When (SAST)', 'Actor', 'Role', 'Action', 'Target type', 'Target ID', 'Org', 'IP'];
    const csvRows = rows.map(r => [
      fmtDate(r.created_at), r.actor_email, r.actor_role, r.action,
      r.target_type, r.target_id || '', r.org_name || '', r.ip || '',
    ]);
    const csv = [headers, ...csvRows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-log-${DateTime.now().toFormat('yyyy-MM-dd')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 2, gap: 1, flexWrap: 'wrap' }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h4">Audit Log</Typography>
          <Typography variant="body2" color="text.secondary">
            {isSuperAdmin
              ? 'Mutations and logins across the platform. Use the org picker in the top bar to scope to a single tenant.'
              : 'Mutations and logins for your organisation.'}
          </Typography>
        </Box>
        <Button variant="outlined" size="small" startIcon={<DownloadIcon />} onClick={exportCsv} disabled={rows.length === 0}>
          Export CSV
        </Button>
      </Box>

      {/* Onboarding context: explain *what* the audit log captures and what
          it doesn't. Without this, an admin who sees only login events
          assumes the audit system is broken — when actually those are the
          only events since the audit log was added (Apr 2026). Auto-fired
          alerts and risk-engine evaluations are intentionally not audited. */}
      <Alert severity="info" sx={{ mb: 2, fontSize: 12 }}>
        <strong>What's audited:</strong> user logins, location / recipient / org / user / settings / invite mutations, alert acknowledgements and test sends.{' '}
        <strong>What's not:</strong> auto-fired alert dispatch (use Alert History instead) and read-only browsing.{' '}
        Mutations that happened before this organisation enabled audit logging won't appear here.
      </Alert>

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

      {isMobile ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {rows.length === 0 ? (
            <Card sx={{ textAlign: 'center', py: 3 }}>
              <Typography color="text.secondary">
                {loading ? 'Loading…' : 'No audit entries match these filters.'}
              </Typography>
            </Card>
          ) : rows.map(r => <MobileAuditCard key={r.id} row={r} />)}
        </Box>
      ) : (
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
      )}

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

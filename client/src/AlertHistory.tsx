import React, { useState, useEffect, useCallback } from 'react';
import {
  Box, Card, CardContent, Typography, Chip, Button, IconButton, Collapse, TextField,
  FormControl, InputLabel, Select, MenuItem, Tooltip, Paper, Checkbox,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TablePagination,
  useMediaQuery, useTheme,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import DownloadIcon from '@mui/icons-material/Download';
import FilterListIcon from '@mui/icons-material/FilterList';
import EmailIcon from '@mui/icons-material/Email';
import SmsIcon from '@mui/icons-material/Sms';
import WhatsAppIcon from '@mui/icons-material/WhatsApp';
import SettingsIcon from '@mui/icons-material/Settings';
import { DateTime } from 'luxon';
import { getAlerts, acknowledgeAlert, acknowledgeAlertsBulk, getLocations } from './api';
import { useToast } from './components/ToastProvider';
import { useCurrentUser } from './App';
import { useOrgScope } from './OrgScope';
import { STATE_CONFIG, stateOf } from './states';
import StateGlossaryButton from './components/StateGlossary';
import EmptyState from './components/EmptyState';
import NotificationsIcon from '@mui/icons-material/Notifications';
import { formatSAST } from './utils/format';

const TYPE_LABELS: Record<string, string> = {
  system: 'System Event',
  email:  'Email',
  sms:    'SMS',
  whatsapp: 'WhatsApp',
};

// Channel icon used in the Notification column. Distinct shapes/colours so an
// operator can verify at a glance whether SMS actually went out vs. only
// email — previously every row showed "System Event" or a tiny text label.
const CHANNEL_ICONS: Record<string, { Icon: React.ElementType; color: string; label: string }> = {
  email:    { Icon: EmailIcon,    color: '#42a5f5', label: 'Email'    },
  sms:      { Icon: SmsIcon,      color: '#ab47bc', label: 'SMS'      },
  whatsapp: { Icon: WhatsAppIcon, color: '#66bb6a', label: 'WhatsApp' },
  system:   { Icon: SettingsIcon, color: '#9e9e9e', label: 'System'   },
};

function ChannelChip({ alertType, recipient }: { alertType: string; recipient: string }) {
  const cfg = CHANNEL_ICONS[alertType] ?? CHANNEL_ICONS.system;
  const Icon = cfg.Icon;
  const isSystem = alertType === 'system';
  return (
    <Tooltip title={isSystem ? 'Internal state-change record (no external recipient)' : `${cfg.label} → ${recipient}`}>
      <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontSize: 12 }}>
        <Icon sx={{ fontSize: 14, color: cfg.color }} />
        <Typography variant="body2" sx={{ fontSize: 12 }}>
          {isSystem ? 'System' : recipient}
        </Typography>
      </Box>
    </Tooltip>
  );
}

// Which states require an explicit operator acknowledgement. STOP/HOLD are the
// "shelter immediately" states and demand a closed loop — but PREPARE is also
// safety-critical (the next strike could push you to STOP), and DEGRADED means
// the engine can't see at all, so we include them too. ALL_CLEAR is implicit.
const ACKABLE_STATES = ['STOP', 'HOLD', 'PREPARE', 'DEGRADED'] as const;
function requiresAck(state: string | null | undefined) {
  return state ? (ACKABLE_STATES as readonly string[]).includes(state) : false;
}

interface AlertRow {
  id: string;
  location_id: string;
  location_name: string;
  state: string;
  state_reason: any;
  alert_type: string;
  recipient: string;
  sent_at: string | null;
  delivered_at: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  escalated: boolean;
  error: string | null;
}

const fmtFull = (s: string | null) => formatSAST(s, 'full');

function getReasonText(reason: any): string {
  if (!reason) return '—';
  if (typeof reason === 'string') return reason;
  return reason.reason || JSON.stringify(reason);
}

export default function AlertHistory() {
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const currentUser = useCurrentUser();
  const canAcknowledge = currentUser?.role === 'operator' || currentUser?.role === 'admin' || currentUser?.role === 'super_admin';
  const { scopedOrgId } = useOrgScope();

  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [filterLocation, setFilterLocation] = useState('');
  const [filterState, setFilterState] = useState<string>('');
  // Default to "unacked only" — operators dropping in to triage a backlog
  // overwhelmingly want pending alerts first; the previous "all" default
  // buried 22 unacked rows under hundreds of acked ones. Persisted in
  // localStorage so power users can keep "all" if they prefer.
  const [filterAcked, setFilterAcked] = useState<'all' | 'acked' | 'unacked'>(
    () => (localStorage.getItem('flashaware_alert_acked_filter') as any) || 'unacked'
  );
  const [filterSince, setFilterSince] = useState('');
  const [filterUntil, setFilterUntil] = useState('');
  const [hasMore, setHasMore] = useState(false);
  // Bulk acknowledgement: visible Pending rows are checkbox-selectable; the
  // toolbar button hits POST /api/ack/bulk in one round-trip. Selection
  // resets on every fetch so a stale id can't be acked twice.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAcking, setBulkAcking] = useState(false);
  const toast = useToast();

  const fetchAlerts = useCallback(async () => {
    try {
      const params: any = { limit: rowsPerPage + 1, offset: page * rowsPerPage };
      if (filterLocation) params.location_id = filterLocation;
      if (filterState) params.state = filterState;
      if (filterAcked !== 'all') params.acked = filterAcked;
      if (filterSince) params.since = new Date(filterSince).toISOString();
      if (filterUntil) params.until = new Date(filterUntil).toISOString();
      if (scopedOrgId) params.org_id = scopedOrgId;
      const res = await getAlerts(params);
      const rows = res.data;
      setHasMore(rows.length > rowsPerPage);
      setAlerts(rows.slice(0, rowsPerPage));
      // Drop any selections that aren't in the new page so a stale id can't
      // be sent to /ack/bulk on the next click.
      setSelectedIds(prev => {
        const visible = new Set(rows.slice(0, rowsPerPage).map((r: AlertRow) => r.id));
        const next = new Set<string>();
        prev.forEach(id => { if (visible.has(id)) next.add(id); });
        return next;
      });
    } catch (err) {
      console.error('Failed to fetch alerts:', err);
    } finally {
      setLoading(false);
    }
  }, [page, rowsPerPage, filterLocation, filterState, filterAcked, filterSince, filterUntil, scopedOrgId]);

  useEffect(() => {
    fetchAlerts();
    getLocations(scopedOrgId ?? undefined).then(res => {
      setLocations(res.data.map((l: any) => ({ id: l.id, name: l.name })));
    }).catch(() => {});
  }, [fetchAlerts, scopedOrgId]);

  const handleAcknowledge = async (alertId: string) => {
    try {
      await acknowledgeAlert(alertId);
      fetchAlerts();
    } catch (err) {
      console.error('Acknowledge failed:', err);
    }
  };

  // Pending rows the operator can ack. System rows for non-ackable states
  // (e.g. ALL_CLEAR system records) aren't selectable to keep the surface
  // honest about what the bulk button will affect.
  const ackableRows = alerts.filter(a => !a.acknowledged_at && requiresAck(a.state));
  const allSelected = ackableRows.length > 0 && ackableRows.every(a => selectedIds.has(a.id));
  const someSelected = ackableRows.some(a => selectedIds.has(a.id)) && !allSelected;

  const toggleSelectAll = () => {
    setSelectedIds(prev => {
      if (allSelected) return new Set();
      const next = new Set(prev);
      ackableRows.forEach(r => next.add(r.id));
      return next;
    });
  };

  const toggleSelectOne = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleBulkAck = async () => {
    if (selectedIds.size === 0 || bulkAcking) return;
    setBulkAcking(true);
    try {
      const res = await acknowledgeAlertsBulk(Array.from(selectedIds));
      const { acked, requested } = res.data;
      if (acked > 0) {
        toast.success(`Acknowledged ${acked} alert${acked === 1 ? '' : 's'}${requested > acked ? ` (${requested - acked} already acked or out of scope)` : ''}`);
      } else {
        toast.warning('No alerts were acknowledged — they may have been acked elsewhere.');
      }
      setSelectedIds(new Set());
      fetchAlerts();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Bulk acknowledge failed');
    } finally {
      setBulkAcking(false);
    }
  };

  const exportCsv = () => {
    const headers = ['ID', 'Location', 'State', 'Type', 'Recipient', 'Sent (SAST)', 'Acknowledged', 'Reason'];
    const rows = alerts.map(a => [
      a.id, a.location_name, a.state, a.alert_type, a.recipient,
      fmtFull(a.sent_at), a.acknowledged_at ? `${fmtFull(a.acknowledged_at)} by ${a.acknowledged_by}` : 'No',
      getReasonText(a.state_reason),
    ]);
    const csv = [headers, ...rows].map(r => r.map(c => `"${c}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `alert-history-${DateTime.now().toFormat('yyyy-MM-dd')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  return (
    <Box>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', mb: 3, gap: 1 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h4" sx={{ fontSize: { xs: 18, sm: 24 } }}>Alert History</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: { xs: 11, sm: 14 } }}>
            Audit trail of all alert notifications
          </Typography>
        </Box>
        <Button variant="outlined" startIcon={<DownloadIcon />} onClick={exportCsv} size="small">
          Export CSV
        </Button>
      </Box>

      {/* Filters */}
      <Box sx={{ display: 'flex', gap: 1.5, mb: 2, alignItems: 'center', flexWrap: 'wrap' }}>
        <FilterListIcon sx={{ color: 'text.secondary', display: { xs: 'none', sm: 'block' } }} />
        <FormControl size="small" sx={{ minWidth: { xs: '100%', sm: 180 } }}>
          <InputLabel>Location</InputLabel>
          <Select value={filterLocation} label="Location"
            onChange={e => { setFilterLocation(e.target.value); setPage(0); }}>
            <MenuItem value="">All locations</MenuItem>
            {locations.map(l => <MenuItem key={l.id} value={l.id}>{l.name}</MenuItem>)}
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth: 130 }}>
          <InputLabel>State</InputLabel>
          <Select value={filterState} label="State"
            onChange={e => { setFilterState(e.target.value); setPage(0); }}>
            <MenuItem value="">All states</MenuItem>
            <MenuItem value="STOP">STOP</MenuItem>
            <MenuItem value="HOLD">HOLD</MenuItem>
            <MenuItem value="PREPARE">PREPARE</MenuItem>
            <MenuItem value="ALL_CLEAR">ALL CLEAR</MenuItem>
            <MenuItem value="DEGRADED">DEGRADED</MenuItem>
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth: 150 }}>
          <InputLabel>Acknowledged</InputLabel>
          <Select value={filterAcked} label="Acknowledged"
            onChange={e => {
              const next = e.target.value as 'all' | 'acked' | 'unacked';
              setFilterAcked(next);
              localStorage.setItem('flashaware_alert_acked_filter', next);
              setPage(0);
            }}>
            <MenuItem value="all">All</MenuItem>
            <MenuItem value="unacked">Only unacked</MenuItem>
            <MenuItem value="acked">Only acked</MenuItem>
          </Select>
        </FormControl>
        <TextField
          label="From"
          type="datetime-local"
          size="small"
          value={filterSince}
          onChange={e => { setFilterSince(e.target.value); setPage(0); }}
          InputLabelProps={{ shrink: true }}
          sx={{ minWidth: 200 }}
        />
        <TextField
          label="To"
          type="datetime-local"
          size="small"
          value={filterUntil}
          onChange={e => { setFilterUntil(e.target.value); setPage(0); }}
          InputLabelProps={{ shrink: true }}
          sx={{ minWidth: 200 }}
        />
        {(filterLocation || filterState || filterAcked !== 'all' || filterSince || filterUntil) && (
          <Button
            size="small"
            onClick={() => {
              setFilterLocation(''); setFilterState(''); setFilterAcked('all');
              setFilterSince(''); setFilterUntil(''); setPage(0);
            }}
          >
            Clear
          </Button>
        )}
      </Box>

      {/* Bulk-action toolbar — only renders when something selectable is on
          screen. Sticky-feeling banner so an operator triaging a backlog can
          select-then-act without losing context. */}
      {canAcknowledge && selectedIds.size > 0 && (
        <Paper
          sx={{
            display: 'flex', alignItems: 'center', gap: 1.5,
            mb: 2, px: 2, py: 1,
            bgcolor: 'rgba(237,108,2,0.12)', border: '1px solid rgba(237,108,2,0.4)',
          }}
        >
          <Typography variant="body2" sx={{ flex: 1 }}>
            <strong>{selectedIds.size}</strong> alert{selectedIds.size === 1 ? '' : 's'} selected
          </Typography>
          <Button size="small" onClick={() => setSelectedIds(new Set())} disabled={bulkAcking}>
            Clear
          </Button>
          <Button
            size="small"
            variant="contained"
            color="warning"
            onClick={handleBulkAck}
            disabled={bulkAcking}
            startIcon={<CheckCircleIcon />}
          >
            {bulkAcking ? 'Acknowledging…' : `Acknowledge selected (${selectedIds.size})`}
          </Button>
        </Paper>
      )}

      {/* Mobile: card list */}
      {isMobile ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {alerts.map(alert => {
            const cfg = STATE_CONFIG[stateOf(alert.state)];
            const ackable = requiresAck(alert.state);
            const isUnacked = !alert.acknowledged_at && ackable;
            const reasonText = getReasonText(alert.state_reason);
            const isSystem = alert.alert_type === 'system';
            const expanded = expandedRow === alert.id;
            return (
              <Card key={alert.id} sx={{
                bgcolor: 'background.paper',
                borderLeft: isUnacked ? '3px solid #ed6c02' : '3px solid transparent',
              }}>
                <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1 }}>
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Typography variant="body2" fontWeight={700} noWrap>{alert.location_name || '—'}</Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                        {fmtFull(alert.sent_at)}
                      </Typography>
                    </Box>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, ml: 1, flexShrink: 0 }}>
                      <Chip label={`${cfg.emoji} ${cfg.label}`} size="small"
                        sx={{ bgcolor: cfg.color, color: cfg.textColor, fontWeight: 700, fontSize: 10, height: 22 }} />
                      {!alert.acknowledged_at && canAcknowledge && ackable && (
                        <Button
                          size="small"
                          variant="contained"
                          color="warning"
                          onClick={(e) => { e.stopPropagation(); handleAcknowledge(alert.id); }}
                          sx={{ minWidth: 72, ml: 'auto' }}
                          aria-label={`Acknowledge alert for ${alert.location_name}`}
                        >
                          ACK
                        </Button>
                      )}
                      <IconButton aria-label="Expand details" size="small" onClick={() => setExpandedRow(expanded ? null : alert.id)}>
                        {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
                      </IconButton>
                    </Box>
                  </Box>

                  <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 0.5, alignItems: 'center' }}>
                    <ChannelChip alertType={alert.alert_type} recipient={alert.recipient} />
                    {alert.error ? (
                      <Chip label="⚠ Failed" size="small" color="error" sx={{ fontSize: 10, height: 20 }} />
                    ) : (
                      <Chip label="✓ Sent" size="small" color="success" variant="outlined" sx={{ fontSize: 10, height: 20 }} />
                    )}
                    {alert.acknowledged_at ? (
                      <Chip icon={<CheckCircleIcon sx={{ fontSize: '12px !important' }} />} label="Acked" size="small" color="success" sx={{ fontSize: 10, height: 20 }} />
                    ) : ackable ? (
                      <Chip label="⚠ Pending ack" size="small" color="warning" variant="outlined" sx={{ fontSize: 10, height: 20 }} />
                    ) : null}
                  </Box>

                  <Collapse in={expanded} timeout="auto" unmountOnExit>
                    <Box sx={{ mt: 1, pt: 1, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                      <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', mb: 0.5 }}>Reason</Typography>
                      <Typography variant="body2" sx={{ fontSize: 12, lineHeight: 1.7, mb: 1 }}>{reasonText}</Typography>
                      {alert.state_reason && typeof alert.state_reason === 'object' && (
                        <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                          {alert.state_reason.stopFlashes !== undefined && <Chip label={`🔴 ${alert.state_reason.stopFlashes} STOP`} size="small" variant="outlined" sx={{ fontSize: 10 }} />}
                          {alert.state_reason.prepareFlashes !== undefined && <Chip label={`🟡 ${alert.state_reason.prepareFlashes} PREP`} size="small" variant="outlined" sx={{ fontSize: 10 }} />}
                          {alert.state_reason.nearestFlashKm != null && <Chip label={`⚡ ${Number(alert.state_reason.nearestFlashKm).toFixed(1)} km`} size="small" variant="outlined" sx={{ fontSize: 10 }} />}
                        </Box>
                      )}
                    </Box>
                  </Collapse>
                </CardContent>
              </Card>
            );
          })}
          {alerts.length === 0 && !loading && (
            <Card>
              <EmptyState
                icon={<NotificationsIcon />}
                title="No alerts match these filters"
                description="Alerts are logged when a location transitions to STOP, HOLD, or DEGRADED."
              />
            </Card>
          )}
          {/* Mobile pagination — uses the same `hasMore` signal as the desktop
              table (over-fetch by 1 to detect the boundary) so the user can't
              click into an empty page on a partial-final result. */}
          <Box sx={{ display: 'flex', justifyContent: 'center', gap: 1, pt: 1 }}>
            <Button size="small" disabled={page === 0} onClick={() => setPage(p => p - 1)}>← Prev</Button>
            <Typography variant="body2" sx={{ alignSelf: 'center', color: 'text.secondary' }}>Page {page + 1}</Typography>
            <Button size="small" disabled={!hasMore} onClick={() => setPage(p => p + 1)}>Next →</Button>
          </Box>
        </Box>
      ) : (
      /* Desktop: table */
      <TableContainer component={Paper} sx={{ bgcolor: 'background.paper', overflowX: 'auto' }}>
        <Table size="small" sx={{ minWidth: 700 }}>
          <TableHead>
            <TableRow sx={{ '& th': { fontWeight: 700, fontSize: 12, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 0.5 } }}>
              {canAcknowledge && (
                <TableCell width={40} padding="checkbox">
                  <Tooltip title={ackableRows.length === 0 ? 'No pending alerts on this page' : (allSelected ? 'Deselect all' : 'Select all pending on this page')}>
                    <span>
                      <Checkbox
                        size="small"
                        indeterminate={someSelected}
                        checked={allSelected}
                        onChange={toggleSelectAll}
                        disabled={ackableRows.length === 0}
                        inputProps={{ 'aria-label': 'Select all pending alerts on this page' }}
                      />
                    </span>
                  </Tooltip>
                </TableCell>
              )}
              <TableCell width={40} />
              <TableCell>Location</TableCell>
              <TableCell>
                <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25 }}>
                  Risk State
                  <StateGlossaryButton size="small" />
                </Box>
              </TableCell>
              <TableCell>Notification</TableCell>
              <TableCell>Triggered (SAST)</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Acknowledged</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {alerts.map(alert => {
              const cfg = STATE_CONFIG[stateOf(alert.state)];
              const ackable = requiresAck(alert.state);
              const isUnacked = !alert.acknowledged_at && ackable;
              const reasonText = getReasonText(alert.state_reason);
              const isSystem = alert.alert_type === 'system';
              return (
              <React.Fragment key={alert.id}>
                <TableRow hover sx={{
                  '& td': { borderBottom: expandedRow === alert.id ? 'none' : undefined },
                  borderLeft: isUnacked ? '3px solid #ed6c02' : '3px solid transparent',
                }}>
                  {canAcknowledge && (
                    <TableCell padding="checkbox">
                      <Checkbox
                        size="small"
                        checked={selectedIds.has(alert.id)}
                        onChange={() => toggleSelectOne(alert.id)}
                        disabled={!isUnacked}
                        inputProps={{ 'aria-label': `Select alert ${alert.id} for bulk acknowledge` }}
                      />
                    </TableCell>
                  )}
                  <TableCell>
                    <IconButton aria-label="Expand details" size="small" onClick={() => setExpandedRow(expandedRow === alert.id ? null : alert.id)}>
                      {expandedRow === alert.id ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
                    </IconButton>
                  </TableCell>

                  {/* Location */}
                  <TableCell>
                    <Typography variant="body2" fontWeight={600}>{alert.location_name || '—'}</Typography>
                  </TableCell>

                  {/* Risk State */}
                  <TableCell>
                    <Chip
                      label={`${cfg.emoji} ${cfg.label}`}
                      size="small"
                      sx={{ bgcolor: cfg.color, color: cfg.textColor, fontWeight: 700, fontSize: 11, px: 0.5 }}
                    />
                  </TableCell>

                  {/* Notification channel + recipient (icon-led so SMS vs email
                      vs system is recognisable at a glance instead of all reading
                      "System Event"). */}
                  <TableCell>
                    <ChannelChip alertType={alert.alert_type} recipient={alert.recipient} />
                  </TableCell>

                  {/* Sent time */}
                  <TableCell>
                    <Typography variant="body2" sx={{ fontSize: 12, fontFamily: 'monospace' }}>
                      {fmtFull(alert.sent_at)}
                    </Typography>
                  </TableCell>

                  {/* Delivery status */}
                  <TableCell>
                    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                      {alert.error ? (
                        <Tooltip title={alert.error}>
                          <Chip label="⚠ Failed" size="small" color="error" sx={{ fontSize: 11 }} />
                        </Tooltip>
                      ) : alert.delivered_at ? (
                        <Chip label="✓ Delivered" size="small" color="success" sx={{ fontSize: 11 }} />
                      ) : alert.sent_at ? (
                        <Chip label="✓ Sent" size="small" color="success" variant="outlined" sx={{ fontSize: 11 }} />
                      ) : (
                        <Chip label="Pending" size="small" sx={{ fontSize: 11 }} />
                      )}
                      {alert.escalated && (
                        <Chip label="↑ Escalated" size="small" color="warning" sx={{ fontSize: 11 }} />
                      )}
                    </Box>
                  </TableCell>

                  {/* Acknowledged. STOP/HOLD/PREPARE/DEGRADED all surface the
                      Pending pill while unacked; ALL_CLEAR (the only non-ackable
                      state) shows an em-dash with a tooltip explaining why,
                      so "N/A" is no longer a mystery for new operators. */}
                  <TableCell>
                    {alert.acknowledged_at ? (
                      <Tooltip title={`Acknowledged by ${alert.acknowledged_by || 'unknown'} at ${fmtFull(alert.acknowledged_at)}`}>
                        <Chip icon={<CheckCircleIcon />} label="Acknowledged" size="small" color="success" sx={{ fontSize: 11 }} />
                      </Tooltip>
                    ) : ackable ? (
                      <Chip label="⚠ Pending" size="small" color="warning" variant="outlined" sx={{ fontSize: 11, fontWeight: 600 }} />
                    ) : (
                      <Tooltip title="ALL CLEAR is informational — clearing is implicit and doesn't require an acknowledgement.">
                        <Typography variant="body2" sx={{ fontSize: 12, cursor: 'help', textDecoration: 'underline dotted' }} color="text.disabled">—</Typography>
                      </Tooltip>
                    )}
                  </TableCell>

                  {/* Actions */}
                  <TableCell align="right">
                    {canAcknowledge && !alert.acknowledged_at && alert.sent_at && ackable && (
                      <Button size="small" variant="contained" color="warning"
                        onClick={() => handleAcknowledge(alert.id)}
                        sx={{ fontSize: 11, py: 0.25, px: 1.5, textTransform: 'none' }}>
                        Acknowledge
                      </Button>
                    )}
                  </TableCell>
                </TableRow>

                {/* Expandable detail row */}
                <TableRow>
                  <TableCell colSpan={canAcknowledge ? 9 : 8} sx={{ py: 0 }}>
                    <Collapse in={expandedRow === alert.id} timeout="auto" unmountOnExit>
                      <Box sx={{ py: 2, px: 3, bgcolor: 'rgba(255,255,255,0.03)', borderRadius: 1, my: 1, borderLeft: `3px solid ${cfg.color}` }}>
                        <Typography variant="subtitle2" sx={{ mb: 1, color: 'text.secondary', textTransform: 'uppercase', fontSize: 11, letterSpacing: 0.5 }}>
                          Trigger reason
                        </Typography>
                        <Typography variant="body2" sx={{ lineHeight: 1.8, mb: 1.5 }}>
                          {reasonText}
                        </Typography>
                        {alert.state_reason && typeof alert.state_reason === 'object' && (
                          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                            {alert.state_reason.stopFlashes !== undefined && (
                              <Chip label={`🔴 ${alert.state_reason.stopFlashes} in STOP zone`} size="small" variant="outlined" sx={{ fontSize: 11 }} />
                            )}
                            {alert.state_reason.prepareFlashes !== undefined && (
                              <Chip label={`🟡 ${alert.state_reason.prepareFlashes} in PREPARE zone`} size="small" variant="outlined" sx={{ fontSize: 11 }} />
                            )}
                            {alert.state_reason.nearestFlashKm != null && (
                              <Chip label={`⚡ Nearest: ${Number(alert.state_reason.nearestFlashKm).toFixed(1)} km`} size="small" variant="outlined" sx={{ fontSize: 11 }} />
                            )}
                            {alert.state_reason.trend && (
                              <Chip label={`📈 Trend: ${alert.state_reason.trend}`} size="small" variant="outlined" sx={{ fontSize: 11 }} />
                            )}
                          </Box>
                        )}
                      </Box>
                    </Collapse>
                  </TableCell>
                </TableRow>
              </React.Fragment>
              );
            })}
            {alerts.length === 0 && !loading && (
              <TableRow>
                <TableCell colSpan={canAcknowledge ? 9 : 8} sx={{ py: 4 }}>
                  <EmptyState
                    icon={<NotificationsIcon />}
                    title="No alerts match these filters"
                    description="Alerts are logged when a location transitions to STOP, HOLD, or DEGRADED."
                  />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <TablePagination
          component="div"
          count={hasMore ? -1 : (page * rowsPerPage + alerts.length)}
          page={page}
          rowsPerPage={rowsPerPage}
          onPageChange={(_, p) => setPage(p)}
          onRowsPerPageChange={e => { setRowsPerPage(parseInt(e.target.value)); setPage(0); }}
          rowsPerPageOptions={[10, 25, 50, 100]}
          labelDisplayedRows={({ from, to }) => `${from}–${to}`}
        />
      </TableContainer>
      )}
    </Box>
  );
}

import React, { useState, useEffect, useCallback } from 'react';
import {
  Box, Card, CardContent, Typography, Chip, Button, IconButton, Collapse, TextField,
  FormControl, InputLabel, Select, MenuItem, Tooltip, Paper,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TablePagination,
  useMediaQuery, useTheme,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import DownloadIcon from '@mui/icons-material/Download';
import FilterListIcon from '@mui/icons-material/FilterList';
import { DateTime } from 'luxon';
import { getAlerts, acknowledgeAlert, getLocations } from './api';
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
};

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
  const [filterAcked, setFilterAcked] = useState<'all' | 'acked' | 'unacked'>('all');
  const [filterSince, setFilterSince] = useState('');
  const [filterUntil, setFilterUntil] = useState('');
  const [hasMore, setHasMore] = useState(false);

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
            onChange={e => { setFilterAcked(e.target.value as 'all' | 'acked' | 'unacked'); setPage(0); }}>
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

      {/* Mobile: card list */}
      {isMobile ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {alerts.map(alert => {
            const cfg = STATE_CONFIG[stateOf(alert.state)];
            const isUnacked = !alert.acknowledged_at && ['STOP','HOLD'].includes(alert.state);
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
                      {!alert.acknowledged_at && canAcknowledge && (
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

                  <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 0.5 }}>
                    {!isSystem && (
                      <Chip label={TYPE_LABELS[alert.alert_type] || alert.alert_type} size="small" variant="outlined" sx={{ fontSize: 10, height: 20 }} />
                    )}
                    {alert.error ? (
                      <Chip label="⚠ Failed" size="small" color="error" sx={{ fontSize: 10, height: 20 }} />
                    ) : (
                      <Chip label="✓ Sent" size="small" color="success" variant="outlined" sx={{ fontSize: 10, height: 20 }} />
                    )}
                    {alert.acknowledged_at ? (
                      <Chip icon={<CheckCircleIcon sx={{ fontSize: '12px !important' }} />} label="Acked" size="small" color="success" sx={{ fontSize: 10, height: 20 }} />
                    ) : isUnacked ? (
                      <Chip label="⚠ Pending ack" size="small" color="warning" variant="outlined" sx={{ fontSize: 10, height: 20 }} />
                    ) : null}
                  </Box>

                  {!isSystem && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                      {alert.recipient}
                    </Typography>
                  )}

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
          {/* Mobile pagination */}
          <Box sx={{ display: 'flex', justifyContent: 'center', gap: 1, pt: 1 }}>
            <Button size="small" disabled={page === 0} onClick={() => setPage(p => p - 1)}>← Prev</Button>
            <Typography variant="body2" sx={{ alignSelf: 'center', color: 'text.secondary' }}>Page {page + 1}</Typography>
            <Button size="small" disabled={alerts.length < rowsPerPage} onClick={() => setPage(p => p + 1)}>Next →</Button>
          </Box>
        </Box>
      ) : (
      /* Desktop: table */
      <TableContainer component={Paper} sx={{ bgcolor: 'background.paper', overflowX: 'auto' }}>
        <Table size="small" sx={{ minWidth: 700 }}>
          <TableHead>
            <TableRow sx={{ '& th': { fontWeight: 700, fontSize: 12, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 0.5 } }}>
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
              const isUnacked = !alert.acknowledged_at && ['STOP','HOLD'].includes(alert.state);
              const reasonText = getReasonText(alert.state_reason);
              const isSystem = alert.alert_type === 'system';
              return (
              <React.Fragment key={alert.id}>
                <TableRow hover sx={{
                  '& td': { borderBottom: expandedRow === alert.id ? 'none' : undefined },
                  borderLeft: isUnacked ? '3px solid #ed6c02' : '3px solid transparent',
                }}>
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

                  {/* Notification type + recipient */}
                  <TableCell>
                    <Typography variant="body2" sx={{ fontSize: 12 }}>
                      {isSystem ? 'System Event' : `${TYPE_LABELS[alert.alert_type] || alert.alert_type} → ${alert.recipient}`}
                    </Typography>
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

                  {/* Acknowledged */}
                  <TableCell>
                    {alert.acknowledged_at ? (
                      <Tooltip title={`Acknowledged by ${alert.acknowledged_by || 'unknown'} at ${fmtFull(alert.acknowledged_at)}`}>
                        <Chip icon={<CheckCircleIcon />} label="Acknowledged" size="small" color="success" sx={{ fontSize: 11 }} />
                      </Tooltip>
                    ) : isUnacked ? (
                      <Chip label="⚠ Pending" size="small" color="warning" variant="outlined" sx={{ fontSize: 11, fontWeight: 600 }} />
                    ) : (
                      <Typography variant="body2" sx={{ fontSize: 12 }} color="text.disabled">N/A</Typography>
                    )}
                  </TableCell>

                  {/* Actions */}
                  <TableCell align="right">
                    {canAcknowledge && !alert.acknowledged_at && alert.sent_at && (
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
                  <TableCell colSpan={8} sx={{ py: 0 }}>
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
                <TableCell colSpan={8} sx={{ py: 4 }}>
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

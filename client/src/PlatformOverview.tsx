import React, { useState, useEffect, useCallback } from 'react';
import {
  Box, Card, CardContent, Typography, Grid, Chip, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, Paper, IconButton, Tooltip, LinearProgress,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import BusinessIcon from '@mui/icons-material/Business';
import LocationOnIcon from '@mui/icons-material/LocationOn';
import NotificationsIcon from '@mui/icons-material/Notifications';
import StorageIcon from '@mui/icons-material/Storage';
import GroupIcon from '@mui/icons-material/Group';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import WarningIcon from '@mui/icons-material/Warning';
import { DateTime } from 'luxon';
import { useNavigate } from 'react-router-dom';
import { getPlatformOverview } from './api';
import { useOrgScope } from './OrgScope';

interface Overview {
  orgs: { active: number; soft_deleted: number };
  users: { active: number };
  locations: { total: number; active: number };
  alerts_24h: { total: number; unacked: number; escalated: number };
  ingestion: {
    last_ingestion: string | null;
    data_age_minutes: number | null;
    feed_healthy: boolean;
    flashes_last_hour: number;
  };
  leader: { am_i_leader: boolean; machine_id: string | null; region: string | null };
  top_orgs_by_alerts: Array<{
    id: string; name: string; slug: string;
    active_locations: number; alerts_24h: number; escalated_24h: number;
  }>;
  needs_attention: Array<{ id: string; name: string; slug: string; unacked_24h: number; escalated_24h: number }>;
  generated_at: string;
}

function Tile({ icon, label, value, sublabel, color }: {
  icon: React.ReactNode; label: string; value: React.ReactNode; sublabel?: string; color?: string;
}) {
  return (
    <Card>
      <CardContent sx={{ '&:last-child': { pb: 2 } }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, color: color || 'text.secondary' }}>
          {icon}
          <Typography variant="caption" sx={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {label}
          </Typography>
        </Box>
        <Typography variant="h4" sx={{ fontWeight: 700 }}>{value}</Typography>
        {sublabel && <Typography variant="caption" color="text.secondary">{sublabel}</Typography>}
      </CardContent>
    </Card>
  );
}

export default function PlatformOverview() {
  const navigate = useNavigate();
  const { setScopedOrgId } = useOrgScope();
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Click an org row → scope the picker to that tenant and open their alerts.
  // Same pattern an admin uses manually via the top-bar org picker.
  const drillIntoOrg = (orgId: string) => {
    setScopedOrgId(orgId);
    navigate('/alerts');
  };

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await getPlatformOverview();
      setData(res.data);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to load overview');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
        <Typography variant="h4" sx={{ flex: 1 }}>Platform Overview</Typography>
        <Tooltip title="Refresh">
          <IconButton aria-label="Refresh" onClick={fetchData} disabled={loading}><RefreshIcon /></IconButton>
        </Tooltip>
      </Box>
      {loading && !data && <LinearProgress sx={{ mb: 2 }} />}
      {error && <Typography color="error" sx={{ mb: 2 }}>{error}</Typography>}

      {data && (
        <>
          {data.needs_attention.length > 0 && (
            <Card sx={{ mb: 3, border: '2px solid', borderColor: 'error.main' }}>
              <CardContent>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                  <WarningIcon sx={{ color: 'error.main' }} />
                  <Typography variant="h6" sx={{ fontSize: 16 }}>Needs attention</Typography>
                </Box>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
                  Tenants with 5+ unacked alerts or any escalation in the last 24 hours.
                </Typography>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Organisation</TableCell>
                      <TableCell align="right">Unacked (24h)</TableCell>
                      <TableCell align="right">Escalated (24h)</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {data.needs_attention.map(o => (
                      <TableRow
                        key={o.id}
                        hover
                        onClick={() => drillIntoOrg(o.id)}
                        sx={{ cursor: 'pointer' }}
                      >
                        <TableCell>
                          <Typography fontWeight={500}>{o.name}</Typography>
                          <Typography variant="caption" color="text.secondary">{o.slug}</Typography>
                        </TableCell>
                        <TableCell align="right">
                          {o.unacked_24h > 0 ? <Chip size="small" label={o.unacked_24h} color="warning" /> : '—'}
                        </TableCell>
                        <TableCell align="right">
                          {o.escalated_24h > 0 ? <Chip size="small" label={o.escalated_24h} color="error" /> : '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
          <Grid container spacing={2} sx={{ mb: 3 }}>
            <Grid item xs={6} md={3}>
              <Tile
                icon={<BusinessIcon />}
                label="Active orgs"
                value={data.orgs.active}
                sublabel={data.orgs.soft_deleted > 0 ? `+${data.orgs.soft_deleted} pending purge` : 'None pending purge'}
              />
            </Grid>
            <Grid item xs={6} md={3}>
              <Tile icon={<GroupIcon />} label="Active users" value={data.users.active} />
            </Grid>
            <Grid item xs={6} md={3}>
              <Tile
                icon={<LocationOnIcon />}
                label="Locations"
                value={data.locations.active}
                sublabel={`${data.locations.total - data.locations.active} disabled`}
              />
            </Grid>
            <Grid item xs={6} md={3}>
              <Tile
                icon={<NotificationsIcon />}
                label="Alerts (24h)"
                value={data.alerts_24h.total}
                sublabel={`${data.alerts_24h.unacked} unacked · ${data.alerts_24h.escalated} escalated`}
                color={data.alerts_24h.unacked > 0 ? 'warning.main' : undefined}
              />
            </Grid>
          </Grid>

          <Grid container spacing={2} sx={{ mb: 3 }}>
            <Grid item xs={12} md={6}>
              <Card>
                <CardContent>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                    {data.ingestion.feed_healthy
                      ? <CheckCircleIcon sx={{ color: 'success.main' }} />
                      : <WarningIcon sx={{ color: 'error.main' }} />}
                    <Typography variant="h6" sx={{ fontSize: 16 }}>EUMETSAT Feed</Typography>
                    <Chip
                      size="small"
                      label={data.ingestion.feed_healthy ? 'HEALTHY' : 'DEGRADED'}
                      color={data.ingestion.feed_healthy ? 'success' : 'error'}
                      sx={{ ml: 'auto' }}
                    />
                  </Box>
                  <Typography variant="body2" color="text.secondary">
                    Last ingestion:{' '}
                    {data.ingestion.last_ingestion
                      ? DateTime.fromISO(data.ingestion.last_ingestion, { zone: 'utc' })
                          .setZone('Africa/Johannesburg').toFormat('yyyy-MM-dd HH:mm:ss')
                      : 'never'}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Data age: {data.ingestion.data_age_minutes !== null ? `${data.ingestion.data_age_minutes} min` : '—'}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Flashes (last hour): <strong>{data.ingestion.flashes_last_hour}</strong>
                  </Typography>
                </CardContent>
              </Card>
            </Grid>

            <Grid item xs={12} md={6}>
              <Card>
                <CardContent>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                    <StorageIcon />
                    <Typography variant="h6" sx={{ fontSize: 16 }}>This machine</Typography>
                    <Chip
                      size="small"
                      label={data.leader.am_i_leader ? 'LEADER' : 'FOLLOWER'}
                      color={data.leader.am_i_leader ? 'primary' : 'default'}
                      sx={{ ml: 'auto' }}
                    />
                  </Box>
                  <Typography variant="body2" color="text.secondary">
                    Machine: <code>{data.leader.machine_id || 'local-dev'}</code>
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Region: <code>{data.leader.region || 'local-dev'}</code>
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                    Background jobs (risk engine, ingestion, escalation, retention) only run on the leader.
                  </Typography>
                </CardContent>
              </Card>
            </Grid>
          </Grid>

          <Typography variant="h6" sx={{ mb: 1, fontSize: 16 }}>Top orgs by 24h alert volume</Typography>
          <TableContainer component={Paper}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Organisation</TableCell>
                  <TableCell align="right">Active locations</TableCell>
                  <TableCell align="right">Alerts (24h)</TableCell>
                  <TableCell align="right">Escalated (24h)</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.top_orgs_by_alerts.length === 0 ? (
                  <TableRow><TableCell colSpan={4} sx={{ textAlign: 'center', py: 4, color: 'text.secondary' }}>No orgs.</TableCell></TableRow>
                ) : data.top_orgs_by_alerts.map(o => (
                  <TableRow
                    key={o.id}
                    hover
                    onClick={() => drillIntoOrg(o.id)}
                    sx={{ cursor: 'pointer' }}
                  >
                    <TableCell>
                      <Typography variant="body2" fontWeight={500}>{o.name}</Typography>
                      <Typography variant="caption" color="text.secondary">{o.slug}</Typography>
                    </TableCell>
                    <TableCell align="right">{o.active_locations}</TableCell>
                    <TableCell align="right">{o.alerts_24h}</TableCell>
                    <TableCell align="right">
                      {o.escalated_24h > 0
                        ? <Chip label={o.escalated_24h} size="small" color="error" sx={{ height: 20, fontSize: 11 }} />
                        : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>

          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
            Generated at {DateTime.fromISO(data.generated_at).toFormat('HH:mm:ss')} · auto-refresh every 30s
          </Typography>
        </>
      )}
    </Box>
  );
}

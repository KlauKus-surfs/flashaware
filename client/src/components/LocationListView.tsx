import React from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Chip,
  IconButton,
  Switch,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
} from '@mui/material';
import LocationOnIcon from '@mui/icons-material/LocationOn';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import EmptyState from './EmptyState';
import { STATE_CONFIG, stateOf } from '../states';

// Pure-presentation list of locations. Renders mobile cards or a desktop
// table depending on `isMobile`. The parent owns all state — this component
// just emits intents.
//
// Pulled out of LocationEditor.tsx because the list rendering is large
// (~130 lines), independent of the edit dialog, and would be the obvious
// thing to skim a screenshot against if the layout regressed.
export interface LocationListItem {
  id: string;
  name: string;
  site_type: string;
  current_state: string | null;
  stop_radius_km: number;
  prepare_radius_km: number;
  enabled: boolean;
  is_demo: boolean;
  org_name?: string | null;
}

interface Props {
  locations: LocationListItem[];
  loading: boolean;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  isMobile: boolean;
  onAdd: () => void;
  onEdit: (loc: LocationListItem) => void;
  onDelete: (loc: LocationListItem) => void;
  onToggleEnabled: (loc: LocationListItem) => void;
}

export function LocationListView({
  locations,
  loading,
  isAdmin,
  isSuperAdmin,
  isMobile,
  onAdd,
  onEdit,
  onDelete,
  onToggleEnabled,
}: Props) {
  if (isMobile) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        {loading &&
          [0, 1, 2].map((i) => <Skeleton key={`m-skel-${i}`} variant="rounded" height={88} />)}
        {!loading &&
          locations.map((loc) => {
            const cfg = STATE_CONFIG[stateOf(loc.current_state)];
            return (
              <Card key={loc.id} sx={{ bgcolor: 'background.paper' }}>
                <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                  <Box
                    sx={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      mb: 1,
                    }}
                  >
                    <Box
                      sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, flex: 1 }}
                    >
                      <LocationOnIcon sx={{ color: cfg.color, fontSize: 20, flexShrink: 0 }} />
                      <Typography variant="body2" fontWeight={600} noWrap>
                        {loc.name}
                      </Typography>
                    </Box>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}>
                      <Chip
                        label={loc.current_state || '?'}
                        size="small"
                        sx={{
                          bgcolor: cfg.color,
                          color: cfg.textColor,
                          fontWeight: 600,
                          fontSize: 10,
                          height: 22,
                        }}
                      />
                      {isAdmin && (
                        <IconButton aria-label="Edit" size="small" onClick={() => onEdit(loc)}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                      )}
                      {isAdmin && (
                        <IconButton
                          aria-label="Delete"
                          size="small"
                          color="error"
                          onClick={() => onDelete(loc)}
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      )}
                    </Box>
                  </Box>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                    <Chip
                      label={loc.site_type.replace('_', ' ')}
                      size="small"
                      variant="outlined"
                      sx={{ fontSize: 10, height: 22 }}
                    />
                    {isSuperAdmin && loc.org_name && (
                      <Chip
                        label={loc.org_name}
                        size="small"
                        variant="outlined"
                        color="primary"
                        sx={{ fontSize: 10, height: 22 }}
                      />
                    )}
                    <Typography variant="caption" color="text.secondary">
                      STOP: {loc.stop_radius_km}km
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      PREP: {loc.prepare_radius_km}km
                    </Typography>
                    {isAdmin && (
                      <Switch
                        checked={loc.enabled}
                        onChange={() => onToggleEnabled(loc)}
                        size="small"
                        sx={{ ml: 'auto' }}
                      />
                    )}
                  </Box>
                </CardContent>
              </Card>
            );
          })}
        {locations.length === 0 && !loading && (
          <Card>
            <EmptyState
              icon={<LocationOnIcon />}
              title="No locations yet"
              description="Add your first monitored location to start tracking lightning risk."
              cta={
                isAdmin ? { label: 'Add location', icon: <AddIcon />, onClick: onAdd } : undefined
              }
            />
          </Card>
        )}
      </Box>
    );
  }

  return (
    <TableContainer component={Paper} sx={{ bgcolor: 'background.paper' }}>
      <Table sx={{ minWidth: 650 }}>
        <TableHead>
          <TableRow>
            <TableCell>Name</TableCell>
            {isSuperAdmin && <TableCell>Organisation</TableCell>}
            <TableCell>Type</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>STOP Radius</TableCell>
            <TableCell>PREPARE Radius</TableCell>
            <TableCell>Enabled</TableCell>
            <TableCell>Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {loading &&
            [0, 1, 2, 3].map((i) => (
              <TableRow key={`d-skel-${i}`}>
                <TableCell colSpan={isSuperAdmin ? 8 : 7} sx={{ py: 1 }}>
                  <Skeleton variant="text" height={28} />
                </TableCell>
              </TableRow>
            ))}
          {!loading &&
            locations.map((loc) => {
              const cfg = STATE_CONFIG[stateOf(loc.current_state)];
              return (
                <TableRow key={loc.id} hover>
                  <TableCell>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <LocationOnIcon sx={{ color: cfg.color, fontSize: 20 }} />
                      <Typography variant="body2" fontWeight={500}>
                        {loc.name}
                      </Typography>
                    </Box>
                  </TableCell>
                  {isSuperAdmin && (
                    <TableCell>
                      <Chip
                        label={loc.org_name || '—'}
                        size="small"
                        variant="outlined"
                        sx={{ fontSize: 11 }}
                      />
                    </TableCell>
                  )}
                  <TableCell>
                    <Chip label={loc.site_type.replace('_', ' ')} size="small" variant="outlined" />
                  </TableCell>
                  <TableCell>
                    <Chip
                      label={loc.current_state || 'UNKNOWN'}
                      size="small"
                      sx={{ bgcolor: cfg.color, color: cfg.textColor, fontWeight: 600 }}
                    />
                  </TableCell>
                  <TableCell>{loc.stop_radius_km} km</TableCell>
                  <TableCell>{loc.prepare_radius_km} km</TableCell>
                  <TableCell>
                    {isAdmin ? (
                      <Switch
                        checked={loc.enabled}
                        onChange={() => onToggleEnabled(loc)}
                        size="small"
                      />
                    ) : (
                      <Chip
                        label={loc.enabled ? 'Enabled' : 'Disabled'}
                        size="small"
                        color={loc.enabled ? 'success' : 'default'}
                        variant="outlined"
                        sx={{ fontSize: 11 }}
                      />
                    )}
                  </TableCell>
                  <TableCell>
                    {isAdmin && (
                      <>
                        <IconButton aria-label="Edit" size="small" onClick={() => onEdit(loc)}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                        <IconButton
                          aria-label="Delete"
                          size="small"
                          color="error"
                          onClick={() => onDelete(loc)}
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          {locations.length === 0 && !loading && (
            <TableRow>
              <TableCell colSpan={isSuperAdmin ? 8 : 7} sx={{ py: 4 }}>
                <EmptyState
                  icon={<LocationOnIcon />}
                  title="No locations yet"
                  description="Add your first monitored location to start tracking lightning risk."
                  cta={
                    isAdmin
                      ? { label: 'Add location', icon: <AddIcon />, onClick: onAdd }
                      : undefined
                  }
                />
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

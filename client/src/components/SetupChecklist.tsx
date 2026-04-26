import React from 'react';
import { Card, CardContent, Typography, Box, Button } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import { useNavigate } from 'react-router-dom';

interface ChecklistState {
  hasLocation: boolean;
  hasRecipient: boolean;
  hasVerifiedPhone: boolean;
}

interface SetupChecklistProps {
  state: ChecklistState;
}

/**
 * Shown at the top of the Dashboard until the user has at least one location
 * and at least one verified-phone recipient. Auto-dismisses once all three
 * boxes are ticked. The point is to give a first-time admin a path forward
 * instead of an empty dashboard.
 */
export default function SetupChecklist({ state }: SetupChecklistProps) {
  const navigate = useNavigate();
  if (state.hasLocation && state.hasRecipient && state.hasVerifiedPhone) return null;

  const items = [
    { done: state.hasLocation,       label: 'Add your first monitored location',          cta: 'Add location',    onClick: () => navigate('/locations') },
    { done: state.hasRecipient,      label: 'Add a person to receive alerts',             cta: 'Add recipient',   onClick: () => navigate('/locations') },
    { done: state.hasVerifiedPhone,  label: 'Verify a phone for SMS / WhatsApp alerts',   cta: 'Verify phone',    onClick: () => navigate('/locations') },
  ];

  return (
    <Card sx={{ mb: 3, border: '1px solid', borderColor: 'primary.main' }}>
      <CardContent>
        <Typography variant="h6" sx={{ fontSize: 16, mb: 1 }}>
          Get started — {items.filter(i => i.done).length} of {items.length} done
        </Typography>
        {items.map((item, i) => (
          <Box key={i} sx={{ display: 'flex', alignItems: 'center', py: 1, gap: 1.5 }}>
            {item.done
              ? <CheckCircleIcon sx={{ color: 'success.main' }} />
              : <RadioButtonUncheckedIcon sx={{ color: 'text.secondary' }} />}
            <Typography sx={{ flex: 1, color: item.done ? 'text.secondary' : 'text.primary', textDecoration: item.done ? 'line-through' : 'none' }}>
              {item.label}
            </Typography>
            {!item.done && (
              <Button size="small" onClick={item.onClick}>{item.cta}</Button>
            )}
          </Box>
        ))}
      </CardContent>
    </Card>
  );
}

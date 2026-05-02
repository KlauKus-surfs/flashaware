import React from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Alert,
  Typography,
  TextField,
  Button,
  CircularProgress,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';

interface Props {
  // Render-driving: the location is null when the dialog should be closed.
  location: { id: string; name: string } | null;
  // Two-key confirmation: typing the name into this field unlocks the button.
  confirmName: string;
  onConfirmNameChange: (next: string) => void;
  onClose: () => void;
  onDelete: () => void;
  deleting: boolean;
}

// Type-the-name confirmation dialog for hard-deleting a location. Splits out
// of LocationEditor because the same shape will likely apply to org-level
// deletion later — different copy, same shape.
export function DeleteLocationDialog({
  location,
  confirmName,
  onConfirmNameChange,
  onClose,
  onDelete,
  deleting,
}: Props) {
  const matches = !!location && confirmName === location.name;

  return (
    <Dialog open={!!location} onClose={() => !deleting && onClose()} maxWidth="sm" fullWidth>
      <DialogTitle>Delete Location</DialogTitle>
      <DialogContent>
        <Alert severity="error" sx={{ mb: 2 }}>
          This will permanently delete <strong>{location?.name}</strong> along with:
          <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
            <li>All risk-state history</li>
            <li>All alerts and acknowledgements</li>
            <li>All notification recipients</li>
          </ul>
          This cannot be undone.
        </Alert>
        <Typography variant="body2" sx={{ mb: 2 }}>
          Type <strong>{location?.name}</strong> to confirm:
        </Typography>
        <TextField
          autoFocus
          fullWidth
          size="small"
          placeholder={location?.name}
          value={confirmName}
          onChange={(e) => onConfirmNameChange(e.target.value)}
          disabled={deleting}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches && !deleting) onDelete();
          }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={deleting}>
          Cancel
        </Button>
        <Button
          variant="contained"
          color="error"
          onClick={onDelete}
          disabled={deleting || !matches}
          startIcon={deleting ? <CircularProgress size={14} /> : <DeleteIcon />}
        >
          {deleting ? 'Deleting…' : 'Delete location'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

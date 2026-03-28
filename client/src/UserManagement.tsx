import React, { useState, useEffect } from 'react';
import {
  Box, Card, CardContent, Typography, Button, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, Paper, IconButton, Dialog, DialogTitle,
  DialogContent, DialogActions, TextField, FormControl, InputLabel, Select,
  MenuItem, Chip, Alert, Snackbar, TablePagination, Tooltip,
  useTheme, useMediaQuery, Divider,
} from '@mui/material';
import {
  Edit as EditIcon,
  Delete as DeleteIcon,
  Add as AddIcon,
  Refresh as RefreshIcon,
  LockReset as LockResetIcon,
} from '@mui/icons-material';
import { resetUserPassword } from './api';
import api from './api';
import { useCurrentUser } from './App';

interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'operator' | 'viewer';
  created_at: string;
}

interface CreateUserForm {
  email: string;
  password: string;
  name: string;
  role: 'admin' | 'operator' | 'viewer';
}

interface EditUserForm {
  email: string;
  name: string;
  role: 'admin' | 'operator' | 'viewer';
  newPassword: string;
}

const ROLE_LABELS: Record<string, string> = {
  admin: 'Administrator',
  operator: 'Operator', 
  viewer: 'Viewer',
};

const ROLE_COLORS: Record<string, 'primary' | 'secondary' | 'default' | 'error' | 'info' | 'success' | 'warning'> = {
  admin: 'error',
  operator: 'warning',
  viewer: 'default',
};

export default function UserManagement() {
  const currentUser = useCurrentUser();
  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'super_admin';

  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [resetPasswordDialogOpen, setResetPasswordDialogOpen] = useState(false);
  const [resetPasswordValue, setResetPasswordValue] = useState('');
  const [resetPasswordConfirm, setResetPasswordConfirm] = useState('');
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [snackbar, setSnackbar] = useState({ open: false, message: '', severity: 'success' as 'success' | 'error' | 'warning' | 'info' });

  // Form states
  const [createForm, setCreateForm] = useState<CreateUserForm>({
    email: '',
    password: '',
    name: '',
    role: 'viewer',
  });
  const [editForm, setEditForm] = useState<EditUserForm>({
    email: '',
    name: '',
    role: 'viewer',
    newPassword: '',
  });

  const fetchUsers = async () => {
    try {
      setLoading(true);
      const response = await api.get('/users');
      setUsers(response.data);
    } catch (error) {
      console.error('Failed to fetch users:', error);
      setSnackbar({ open: true, message: 'Failed to fetch users', severity: 'error' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const handleCreateUser = async () => {
    try {
      await api.post('/users', createForm);
      setSnackbar({ open: true, message: 'User created successfully', severity: 'success' });
      setCreateDialogOpen(false);
      setCreateForm({ email: '', password: '', name: '', role: 'viewer' });
      fetchUsers();
    } catch (error: any) {
      const message = error.response?.data?.error || 'Failed to create user';
      setSnackbar({ open: true, message, severity: 'error' });
    }
  };

  const handleUpdateUser = async () => {
    if (!selectedUser) return;
    
    try {
      const payload: any = { email: editForm.email, name: editForm.name, role: editForm.role };
      if (editForm.newPassword.trim()) payload.password = editForm.newPassword.trim();
      await api.put(`/users/${selectedUser.id}`, payload);
      setSnackbar({ open: true, message: 'User updated successfully', severity: 'success' });
      setEditDialogOpen(false);
      setSelectedUser(null);
      fetchUsers();
    } catch (error: any) {
      const message = error.response?.data?.error || 'Failed to update user';
      setSnackbar({ open: true, message, severity: 'error' });
    }
  };

  const handleDeleteUser = async () => {
    if (!selectedUser) return;
    
    try {
      await api.delete(`/users/${selectedUser.id}`);
      setSnackbar({ open: true, message: 'User deleted successfully', severity: 'success' });
      setDeleteDialogOpen(false);
      setSelectedUser(null);
      fetchUsers();
    } catch (error: any) {
      const message = error.response?.data?.error || 'Failed to delete user';
      setSnackbar({ open: true, message, severity: 'error' });
    }
  };

  const openEditDialog = (user: User) => {
    setSelectedUser(user);
    setEditForm({
      email: user.email,
      name: user.name,
      role: user.role,
      newPassword: '',
    });
    setEditDialogOpen(true);
  };

  const openDeleteDialog = (user: User) => {
    setSelectedUser(user);
    setDeleteDialogOpen(true);
  };

  const openResetPasswordDialog = (user: User) => {
    setSelectedUser(user);
    setResetPasswordValue('');
    setResetPasswordConfirm('');
    setResetPasswordDialogOpen(true);
  };

  const handleResetPassword = async () => {
    if (!selectedUser) return;
    if (resetPasswordValue.length < 6) {
      setSnackbar({ open: true, message: 'Password must be at least 6 characters', severity: 'error' });
      return;
    }
    if (resetPasswordValue !== resetPasswordConfirm) {
      setSnackbar({ open: true, message: 'Passwords do not match', severity: 'error' });
      return;
    }
    try {
      await resetUserPassword(selectedUser.id, resetPasswordValue);
      setSnackbar({ open: true, message: `Password reset for ${selectedUser.name}`, severity: 'success' });
      setResetPasswordDialogOpen(false);
      setSelectedUser(null);
    } catch (error: any) {
      const message = error.response?.data?.error || 'Failed to reset password';
      setSnackbar({ open: true, message, severity: 'error' });
    }
  };

  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-ZA', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const handleChangePage = (event: unknown, newPage: number) => {
    setPage(newPage);
  };

  const handleChangeRowsPerPage = (event: React.ChangeEvent<HTMLInputElement>) => {
    setRowsPerPage(parseInt(event.target.value, 10));
    setPage(0);
  };

  if (!isAdmin) {
    return (
      <Box>
        <Typography variant="h4" sx={{ fontSize: { xs: 24, sm: 28 }, fontWeight: 700, mb: 3 }}>User Management</Typography>
        <Alert severity="warning">
          You do not have permission to manage users. Contact an administrator if you need access.
        </Alert>
      </Box>
    );
  }

  return (
    <Box>
      {/* Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Typography variant="h4" sx={{ fontSize: { xs: 24, sm: 28 }, fontWeight: 700 }}>
          User Management
        </Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Tooltip title="Refresh users">
            <IconButton onClick={fetchUsers} disabled={loading}>
              <RefreshIcon />
            </IconButton>
          </Tooltip>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setCreateDialogOpen(true)}
          >
            Add User
          </Button>
        </Box>
      </Box>

      {/* Mobile: card list */}
      {isMobile ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {loading ? (
            <Card><CardContent><Typography color="text.secondary" align="center">Loading users...</Typography></CardContent></Card>
          ) : users.length === 0 ? (
            <Card><CardContent><Typography color="text.secondary" align="center">No users found.</Typography></CardContent></Card>
          ) : (
            users.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage).map(user => (
              <Card key={user.id} sx={{ bgcolor: 'background.paper' }}>
                <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Typography variant="body2" fontWeight={700}>{user.name}</Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ wordBreak: 'break-all' }}>{user.email}</Typography>
                    </Box>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, ml: 1, flexShrink: 0 }}>
                      <Chip label={ROLE_LABELS[user.role]} color={ROLE_COLORS[user.role]} size="small" variant="outlined" sx={{ fontSize: 10, height: 22 }} />
                      <Tooltip title="Edit user"><IconButton size="small" onClick={() => openEditDialog(user)}><EditIcon fontSize="small" /></IconButton></Tooltip>
                      <Tooltip title="Reset password"><IconButton size="small" color="warning" onClick={() => openResetPasswordDialog(user)}><LockResetIcon fontSize="small" /></IconButton></Tooltip>
                      <Tooltip title="Delete user"><IconButton size="small" color="error" onClick={() => openDeleteDialog(user)}><DeleteIcon fontSize="small" /></IconButton></Tooltip>
                    </Box>
                  </Box>
                  <Typography variant="caption" color="text.disabled" sx={{ mt: 0.5, display: 'block' }}>
                    Created {formatDate(user.created_at)}
                  </Typography>
                </CardContent>
              </Card>
            ))
          )}
          <Box sx={{ display: 'flex', justifyContent: 'center', gap: 1, pt: 1 }}>
            <Button size="small" disabled={page === 0} onClick={() => setPage(p => p - 1)}>← Prev</Button>
            <Typography variant="body2" sx={{ alignSelf: 'center', color: 'text.secondary' }}>Page {page + 1}</Typography>
            <Button size="small" disabled={(page + 1) * rowsPerPage >= users.length} onClick={() => setPage(p => p + 1)}>Next →</Button>
          </Box>
        </Box>
      ) : (
      /* Desktop: table */
      <Card>
        <CardContent sx={{ p: 0 }}>
          <TableContainer>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>Name</TableCell>
                  <TableCell>Email</TableCell>
                  <TableCell>Role</TableCell>
                  <TableCell>Created</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={5} align="center" sx={{ py: 4 }}>
                      <Typography color="text.secondary">Loading users...</Typography>
                    </TableCell>
                  </TableRow>
                ) : users.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} align="center" sx={{ py: 4 }}>
                      <Typography color="text.secondary">No users found</Typography>
                    </TableCell>
                  </TableRow>
                ) : (
                  users
                    .slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage)
                    .map((user) => (
                      <TableRow key={user.id} hover>
                        <TableCell>
                          <Typography variant="body2" fontWeight={500}>
                            {user.name}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2" color="text.secondary">
                            {user.email}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Chip
                            label={ROLE_LABELS[user.role]}
                            color={ROLE_COLORS[user.role]}
                            size="small"
                            variant="outlined"
                          />
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2" color="text.secondary">
                            {formatDate(user.created_at)}
                          </Typography>
                        </TableCell>
                        <TableCell align="right">
                          <Tooltip title="Edit user">
                            <IconButton size="small" onClick={() => openEditDialog(user)}>
                              <EditIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="Reset password">
                            <IconButton size="small" color="warning" onClick={() => openResetPasswordDialog(user)}>
                              <LockResetIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="Delete user">
                            <IconButton size="small" color="error" onClick={() => openDeleteDialog(user)}>
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    ))
                )}
              </TableBody>
            </Table>
          </TableContainer>
          <TablePagination
            rowsPerPageOptions={[5, 10, 25]}
            component="div"
            count={users.length}
            rowsPerPage={rowsPerPage}
            page={page}
            onPageChange={handleChangePage}
            onRowsPerPageChange={handleChangeRowsPerPage}
          />
        </CardContent>
      </Card>
      )}

      {/* Create User Dialog */}
      <Dialog open={createDialogOpen} onClose={() => setCreateDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Create New User</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
            <TextField
              label="Email"
              type="email"
              fullWidth
              value={createForm.email}
              onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })}
              required
            />
            <TextField
              label="Password"
              type="password"
              fullWidth
              value={createForm.password}
              onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })}
              required
              helperText="Minimum 6 characters"
            />
            <TextField
              label="Full Name"
              fullWidth
              value={createForm.name}
              onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
              required
            />
            <FormControl fullWidth required>
              <InputLabel>Role</InputLabel>
              <Select
                value={createForm.role}
                label="Role"
                onChange={(e) => setCreateForm({ ...createForm, role: e.target.value as any })}
              >
                <MenuItem value="viewer">Viewer</MenuItem>
                <MenuItem value="operator">Operator</MenuItem>
                <MenuItem value="admin">Administrator</MenuItem>
              </Select>
            </FormControl>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleCreateUser} variant="contained">
            Create User
          </Button>
        </DialogActions>
      </Dialog>

      {/* Edit User Dialog */}
      <Dialog open={editDialogOpen} onClose={() => setEditDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Edit User</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
            <TextField
              label="Email"
              type="email"
              fullWidth
              value={editForm.email}
              onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
              required
            />
            <TextField
              label="Full Name"
              fullWidth
              value={editForm.name}
              onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
              required
            />
            <FormControl fullWidth required>
              <InputLabel>Role</InputLabel>
              <Select
                value={editForm.role}
                label="Role"
                onChange={(e) => setEditForm({ ...editForm, role: e.target.value as any })}
              >
                <MenuItem value="viewer">Viewer</MenuItem>
                <MenuItem value="operator">Operator</MenuItem>
                <MenuItem value="admin">Administrator</MenuItem>
              </Select>
            </FormControl>
            <TextField
              label="New Password"
              type="password"
              fullWidth
              value={editForm.newPassword}
              onChange={(e) => setEditForm({ ...editForm, newPassword: e.target.value })}
              helperText="Leave blank to keep current password"
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleUpdateUser} variant="contained">
            Update User
          </Button>
        </DialogActions>
      </Dialog>

      {/* Reset Password Dialog */}
      <Dialog open={resetPasswordDialogOpen} onClose={() => setResetPasswordDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Reset Password — {selectedUser?.name}</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              Set a new password for <strong>{selectedUser?.email}</strong>. The user will need to use this password on their next login.
            </Typography>
            <TextField
              label="New Password"
              type="password"
              fullWidth
              value={resetPasswordValue}
              onChange={(e) => setResetPasswordValue(e.target.value)}
              helperText="Minimum 6 characters"
              autoFocus
            />
            <TextField
              label="Confirm Password"
              type="password"
              fullWidth
              value={resetPasswordConfirm}
              onChange={(e) => setResetPasswordConfirm(e.target.value)}
              error={resetPasswordConfirm.length > 0 && resetPasswordValue !== resetPasswordConfirm}
              helperText={resetPasswordConfirm.length > 0 && resetPasswordValue !== resetPasswordConfirm ? 'Passwords do not match' : ''}
              onKeyDown={(e) => { if (e.key === 'Enter') handleResetPassword(); }}
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setResetPasswordDialogOpen(false)}>Cancel</Button>
          <Button
            onClick={handleResetPassword}
            variant="contained"
            color="warning"
            disabled={resetPasswordValue.length < 6 || resetPasswordValue !== resetPasswordConfirm}
          >
            Reset Password
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete User Dialog */}
      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Delete User</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to delete the user "{selectedUser?.name}" ({selectedUser?.email})? 
            This action cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleDeleteUser} color="error" variant="contained">
            Delete User
          </Button>
        </DialogActions>
      </Dialog>

      {/* Snackbar */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={6000}
        onClose={() => setSnackbar({ ...snackbar, open: false })}
      >
        <Alert
          onClose={() => setSnackbar({ ...snackbar, open: false })}
          severity={snackbar.severity}
          sx={{ width: '100%' }}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
}

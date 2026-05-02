import React, { useState, useEffect } from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Button,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Chip,
  Alert,
  TablePagination,
  Tooltip,
  Skeleton,
  useTheme,
  useMediaQuery,
} from '@mui/material';
import EmptyState from './components/EmptyState';
import PeopleIcon from '@mui/icons-material/People';
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
import { useToast } from './components/ToastProvider';
import { formatSAST } from './utils/format';
import {
  AddUserDialog,
  EditUserDialog,
  DeleteUserDialog,
  type UserRow,
} from './components/UserDialogs';
import InfoTip from './components/InfoTip';
import { helpBody, helpTitle } from './help/copy';

type User = UserRow & { created_at: string };

const ROLE_LABELS: Record<string, string> = {
  admin: 'Administrator',
  operator: 'Operator',
  viewer: 'Viewer',
};

const ROLE_COLORS: Record<
  string,
  'primary' | 'secondary' | 'default' | 'error' | 'info' | 'success' | 'warning'
> = {
  admin: 'error',
  operator: 'warning',
  viewer: 'default',
};

export default function UserManagement() {
  const currentUser = useCurrentUser();
  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'super_admin';
  const toast = useToast();

  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<User | null>(null);
  const [editIndex, setEditIndex] = useState<number>(-1);
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null);
  const [resetPasswordTarget, setResetPasswordTarget] = useState<User | null>(null);
  const [resetPasswordValue, setResetPasswordValue] = useState('');
  const [resetPasswordConfirm, setResetPasswordConfirm] = useState('');

  const fetchUsers = async () => {
    try {
      setLoading(true);
      const response = await api.get('/users');
      setUsers(response.data);
    } catch (error) {
      console.error('Failed to fetch users:', error);
      toast.error('Failed to fetch users');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const openEditDialog = (user: User) => {
    setEditIndex(users.findIndex((u) => u.id === user.id));
    setEditTarget(user);
  };

  const navigateEditUser = (direction: 'prev' | 'next') => {
    const newIndex = direction === 'prev' ? editIndex - 1 : editIndex + 1;
    if (newIndex < 0 || newIndex >= users.length) return;
    setEditIndex(newIndex);
    setEditTarget(users[newIndex]);
  };

  const openResetPasswordDialog = (user: User) => {
    setResetPasswordTarget(user);
    setResetPasswordValue('');
    setResetPasswordConfirm('');
  };

  const handleResetPassword = async () => {
    if (!resetPasswordTarget) return;
    if (resetPasswordValue.length < 6) {
      toast.error('Password must be at least 6 characters');
      return;
    }
    if (resetPasswordValue !== resetPasswordConfirm) {
      toast.error('Passwords do not match');
      return;
    }
    try {
      await resetUserPassword(resetPasswordTarget.id, resetPasswordValue);
      toast.success(`Password reset for ${resetPasswordTarget.name}`);
      setResetPasswordTarget(null);
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to reset password');
    }
  };

  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  const formatDate = (dateString: string) => formatSAST(dateString, 'full');

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
        <Typography variant="h4" sx={{ fontSize: { xs: 24, sm: 28 }, fontWeight: 700, mb: 3 }}>
          User Management
        </Typography>
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
        <Box sx={{ display: 'flex', alignItems: 'center' }}>
          <Typography variant="h4" sx={{ fontSize: { xs: 24, sm: 28 }, fontWeight: 700 }}>
            User Management
          </Typography>
          <InfoTip
            variant="dialog"
            title={helpTitle('role_permissions')}
            body={helpBody('role_permissions')}
            ariaLabel="What can each role do?"
          />
        </Box>
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
            [0, 1, 2].map((i) => <Skeleton key={i} variant="rounded" height={88} />)
          ) : users.length === 0 ? (
            <EmptyState
              icon={<PeopleIcon />}
              title="No users yet"
              description="Add a teammate so they can sign in and acknowledge alerts."
              cta={{
                label: 'Add user',
                icon: <AddIcon />,
                onClick: () => setCreateDialogOpen(true),
              }}
            />
          ) : (
            users.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage).map((user) => (
              <Card key={user.id} sx={{ bgcolor: 'background.paper' }}>
                <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                  <Box
                    sx={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                    }}
                  >
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Typography variant="body2" fontWeight={700}>
                        {user.name}
                      </Typography>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ wordBreak: 'break-all' }}
                      >
                        {user.email}
                      </Typography>
                    </Box>
                    <Box
                      sx={{ display: 'flex', alignItems: 'center', gap: 0.5, ml: 1, flexShrink: 0 }}
                    >
                      <Chip
                        label={ROLE_LABELS[user.role]}
                        color={ROLE_COLORS[user.role]}
                        size="small"
                        variant="outlined"
                        sx={{ fontSize: 10, height: 22 }}
                      />
                      <Tooltip title="Edit user">
                        <IconButton size="small" onClick={() => openEditDialog(user)}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Reset password">
                        <IconButton
                          size="small"
                          color="warning"
                          onClick={() => openResetPasswordDialog(user)}
                        >
                          <LockResetIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Delete user">
                        <IconButton
                          size="small"
                          color="error"
                          onClick={() => setDeleteTarget(user)}
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Box>
                  </Box>
                  <Typography
                    variant="caption"
                    color="text.disabled"
                    sx={{ mt: 0.5, display: 'block' }}
                  >
                    Created {formatDate(user.created_at)}
                  </Typography>
                </CardContent>
              </Card>
            ))
          )}
          <Box sx={{ display: 'flex', justifyContent: 'center', gap: 1, pt: 1 }}>
            <Button size="small" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              ← Prev
            </Button>
            <Typography variant="body2" sx={{ alignSelf: 'center', color: 'text.secondary' }}>
              Page {page + 1}
            </Typography>
            <Button
              size="small"
              disabled={(page + 1) * rowsPerPage >= users.length}
              onClick={() => setPage((p) => p + 1)}
            >
              Next →
            </Button>
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
                    [0, 1, 2, 3].map((i) => (
                      <TableRow key={i}>
                        <TableCell colSpan={5} sx={{ py: 1 }}>
                          <Skeleton variant="text" height={32} />
                        </TableCell>
                      </TableRow>
                    ))
                  ) : users.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} sx={{ py: 4 }}>
                        <EmptyState
                          icon={<PeopleIcon />}
                          title="No users yet"
                          description="Add a teammate so they can sign in and acknowledge alerts."
                          cta={{
                            label: 'Add user',
                            icon: <AddIcon />,
                            onClick: () => setCreateDialogOpen(true),
                          }}
                        />
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
                              <IconButton
                                size="small"
                                color="warning"
                                onClick={() => openResetPasswordDialog(user)}
                              >
                                <LockResetIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                            <Tooltip title="Delete user">
                              <IconButton
                                size="small"
                                color="error"
                                onClick={() => setDeleteTarget(user)}
                              >
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

      <AddUserDialog
        open={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        onCreated={fetchUsers}
      />

      <EditUserDialog
        target={editTarget}
        onClose={() => {
          setEditTarget(null);
          setEditIndex(-1);
        }}
        onSaved={fetchUsers}
        navigation={
          editTarget
            ? {
                index: editIndex,
                total: users.length,
                onPrev: () => navigateEditUser('prev'),
                onNext: () => navigateEditUser('next'),
              }
            : undefined
        }
      />

      <DeleteUserDialog
        target={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDeleted={fetchUsers}
      />

      {/* Reset Password Dialog — unique to this page (no equivalent in
          OrgManagement, which sets passwords via the edit form). */}
      <Dialog
        open={!!resetPasswordTarget}
        onClose={() => setResetPasswordTarget(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Reset Password — {resetPasswordTarget?.name}</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              Set a new password for <strong>{resetPasswordTarget?.email}</strong>. The user will
              need to use this password on their next login.
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
              helperText={
                resetPasswordConfirm.length > 0 && resetPasswordValue !== resetPasswordConfirm
                  ? 'Passwords do not match'
                  : ''
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleResetPassword();
              }}
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setResetPasswordTarget(null)}>Cancel</Button>
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
    </Box>
  );
}

import React, { useState, useEffect, useMemo, createContext, useContext } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import {
  ThemeProvider, createTheme, CssBaseline, Box, AppBar, Toolbar, Typography,
  Drawer, List, ListItemButton, ListItemIcon, ListItemText, Divider, Chip,
  IconButton, Avatar, Menu, MenuItem, TextField, Button, Paper, Alert,
  Dialog, DialogTitle, DialogContent, DialogActions,
  useMediaQuery, useTheme,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import KeyIcon from '@mui/icons-material/Key';
import DashboardIcon from '@mui/icons-material/Dashboard';
import LocationOnIcon from '@mui/icons-material/LocationOn';
import NotificationsIcon from '@mui/icons-material/Notifications';
import ReplayIcon from '@mui/icons-material/Replay';
import SettingsIcon from '@mui/icons-material/Settings';
import LogoutIcon from '@mui/icons-material/Logout';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import LightModeIcon from '@mui/icons-material/LightMode';
import FlashOnIcon from '@mui/icons-material/FlashOn';
import PeopleIcon from '@mui/icons-material/People';
import MenuIcon from '@mui/icons-material/Menu';
import BusinessIcon from '@mui/icons-material/Business';
import HistoryIcon from '@mui/icons-material/History';
import InsightsIcon from '@mui/icons-material/Insights';

import Dashboard from './Dashboard';
import LocationEditor from './LocationEditor';
import AlertHistory from './AlertHistory';
import Replay from './Replay';
import Settings from './Settings';
import UserManagement from './UserManagement';
import OrgManagement from './OrgManagement';
import AuditLog from './AuditLog';
import PlatformOverview from './PlatformOverview';
import Register from './Register';
import { loginApi, getHealth, updateMyProfile } from './api';
import { OrgScopeProvider, OrgPicker, SCOPED_ORG_STORAGE_KEY } from './OrgScope';
import OrgScopeBanner from './components/OrgScopeBanner';
import { ToastProvider, useToast } from './components/ToastProvider';

const DRAWER_WIDTH = 240;

// Brand primary is a desaturated indigo, deliberately picked to NOT collide
// with the PREPARE state color (yellow). Buttons no longer "feel" like
// warnings, and PREPARE pills now read as the only yellow on screen.
const PRIMARY_MAIN = '#7986cb';

const sharedThemeOptions = {
  typography: {
    fontFamily: '"Inter", "Roboto", "Helvetica", "Arial", sans-serif',
    h4: { fontWeight: 700, letterSpacing: '-0.01em' },
    h5: { fontWeight: 600, letterSpacing: '-0.005em' },
    h6: { fontWeight: 600 },
  },
  shape: { borderRadius: 12 },
  components: {
    MuiCard: {
      styleOverrides: {
        root: { backgroundImage: 'none' },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: { textTransform: 'none' as const },
      },
    },
  },
} as const;

const darkTheme = createTheme({
  ...sharedThemeOptions,
  palette: {
    mode: 'dark',
    primary: { main: PRIMARY_MAIN },
    secondary: { main: '#ef6c00' },
    background: { default: '#0a1929', paper: '#132f4c' },
    success: { main: '#2e7d32' },
    warning: { main: '#ed6c02' },
    error: { main: '#d32f2f' },
  },
});

const lightTheme = createTheme({
  ...sharedThemeOptions,
  palette: {
    mode: 'light',
    primary: { main: '#3f51b5' },
    secondary: { main: '#ef6c00' },
    background: { default: '#f5f6fa', paper: '#ffffff' },
    success: { main: '#2e7d32' },
    warning: { main: '#ed6c02' },
    error: { main: '#d32f2f' },
  },
});

type ThemeMode = 'dark' | 'light';
const ThemeModeContext = createContext<{ mode: ThemeMode; toggle: () => void }>({
  mode: 'dark',
  toggle: () => {},
});
export function useThemeMode() { return useContext(ThemeModeContext); }

const STATE_COLORS: Record<string, string> = {
  ALL_CLEAR: '#2e7d32',
  PREPARE: '#fbc02d',
  STOP: '#d32f2f',
  HOLD: '#ed6c02',
  DEGRADED: '#9e9e9e',
};

interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
  org_id?: string;
  // Sent on the login response so we can show "{name} · {org_name}" in the
  // avatar menu without a follow-up fetch. Optional because older tokens in
  // localStorage from before this field shipped won't have it.
  org_name?: string;
  // Server flag set when the user authenticated with a known-default password
  // (e.g. seeded `admin123`). When true the layout opens the change-password
  // dialog with a forcing banner instead of dropping the user on /. NOT
  // persisted to localStorage — it's a one-shot signal scoped to the session.
  must_change_password?: boolean;
}

export const UserContext = createContext<AuthUser | null>(null);
export function useCurrentUser() { return useContext(UserContext); }

// Login Page
function LoginPage({ onLogin }: { onLogin: (user: AuthUser, token: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await loginApi(email, password);
      onLogin(res.data.user, res.data.token);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: 'background.default' }}>
      <Paper sx={{ p: 4, maxWidth: 400, width: '100%' }}>
        <Box sx={{ textAlign: 'center', mb: 3 }}>
          <FlashOnIcon sx={{ fontSize: 48, color: '#fbc02d' }} />
          <Typography variant="h5" sx={{ mt: 1 }}>FlashAware System</Typography>
          <Typography variant="body2" color="text.secondary">Sign in to continue</Typography>
        </Box>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        <form onSubmit={handleSubmit}>
          <TextField fullWidth label="Email" type="email" value={email}
            onChange={e => setEmail(e.target.value)}
            sx={{ mb: 2 }} size="small"
            autoFocus
            inputProps={{ name: 'email', autoComplete: 'email' }} />
          <TextField fullWidth label="Password" type="password" value={password}
            onChange={e => setPassword(e.target.value)} sx={{ mb: 3 }} size="small"
            inputProps={{ name: 'current-password', autoComplete: 'current-password' }} />
          <Button fullWidth variant="contained" type="submit" disabled={loading} size="large">
            {loading ? 'Signing in…' : 'Sign In'}
          </Button>
        </form>
      </Paper>
    </Box>
  );
}

// Navigation Sidebar
function NavSidebar({ mobileOpen, onMobileClose, user }: { mobileOpen: boolean; onMobileClose: () => void; user: AuthUser }) {
  const location = useLocation();
  const navigate = useNavigate();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const isAdminOrAbove = user.role === 'admin' || user.role === 'super_admin';
  const navItems = [
    { path: '/', label: 'Dashboard', icon: <DashboardIcon /> },
    { path: '/locations', label: 'Locations', icon: <LocationOnIcon /> },
    { path: '/alerts', label: 'Alert History', icon: <NotificationsIcon /> },
    { path: '/replay', label: 'Replay', icon: <ReplayIcon /> },
    ...(isAdminOrAbove && user.role !== 'super_admin' ? [{ path: '/users', label: 'Users', icon: <PeopleIcon /> }] : []),
    ...(isAdminOrAbove ? [{ path: '/audit', label: 'Audit Log', icon: <HistoryIcon /> }] : []),
    // Settings has been admin-only since the user-management table was removed —
    // viewers and operators now land on a near-empty page. Hide it for them.
    ...(isAdminOrAbove ? [{ path: '/settings', label: 'Settings', icon: <SettingsIcon /> }] : []),
    ...(user.role === 'super_admin' ? [
      { path: '/platform', label: 'Platform', icon: <InsightsIcon /> },
      { path: '/orgs', label: 'Organisations', icon: <BusinessIcon /> },
    ] : []),
  ];

  // Imperative navigate (vs `component={Link} to=...`) so a click always
  // resolves through React Router's navigation hook. The Link component
  // hands native click handling to the anchor, which intermittently lost
  // its handler when the active route mounted heavy children (Leaflet
  // listeners on Replay / Dashboard) — leaving the Dashboard nav item
  // visually selectable but unresponsive.
  const handleNavClick = (path: string) => {
    if (isMobile) onMobileClose();
    if (location.pathname !== path) navigate(path);
  };

  const drawerContent = (
    <>
      <Toolbar sx={{ gap: 1 }}>
        <FlashOnIcon sx={{ color: '#fbc02d' }} />
        <Typography variant="h6" noWrap sx={{ fontSize: 16, flexGrow: 1 }}>FlashAware</Typography>
        {isMobile && (
          <IconButton
            size="small"
            onClick={onMobileClose}
            aria-label="Close navigation"
            edge="end"
          >
            <CloseIcon />
          </IconButton>
        )}
      </Toolbar>
      <Divider />
      <List sx={{ px: 1 }}>
        {navItems.map(item => (
          <ListItemButton
            key={item.path}
            selected={location.pathname === item.path}
            onClick={() => handleNavClick(item.path)}
            sx={{ borderRadius: 2, mb: 0.5 }}
          >
            <ListItemIcon sx={{ minWidth: 40 }}>{item.icon}</ListItemIcon>
            <ListItemText primary={item.label} primaryTypographyProps={{ fontSize: 14 }} />
          </ListItemButton>
        ))}
      </List>
    </>
  );

  if (isMobile) {
    return (
      <Drawer
        variant="temporary"
        open={mobileOpen}
        onClose={onMobileClose}
        ModalProps={{ keepMounted: true }}
        sx={{
          '& .MuiDrawer-paper': { width: DRAWER_WIDTH, boxSizing: 'border-box', bgcolor: 'background.paper' },
        }}
      >
        {drawerContent}
      </Drawer>
    );
  }

  return (
    <Drawer
      variant="permanent"
      sx={{
        width: DRAWER_WIDTH,
        flexShrink: 0,
        '& .MuiDrawer-paper': {
          width: DRAWER_WIDTH,
          boxSizing: 'border-box',
          bgcolor: 'background.paper',
          borderRight: '1px solid rgba(255,255,255,0.08)',
        },
      }}
    >
      {drawerContent}
    </Drawer>
  );
}

// Lightweight change-password dialog mounted next to the avatar menu so any
// signed-in user can rotate their own password without an admin reset. Uses
// the self-update branch of PUT /api/users/:id (server allows password for
// self-edit).
function ChangePasswordDialog({
  open, onClose, userId, forced,
}: { open: boolean; onClose: () => void; userId: string; forced?: boolean }) {
  const toast = useToast();
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState('');

  useEffect(() => {
    if (open) { setNext(''); setConfirm(''); setServerError(''); }
  }, [open]);

  const canSubmit = next.length >= 6 && next === confirm && !saving;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setServerError('');
    try {
      await updateMyProfile(userId, { password: next });
      toast.success('Password updated');
      onClose();
    } catch (err: any) {
      // Surface the API's "banned password" message inline as well as via the
      // toast — when the dialog is forced (post-default-password login) the
      // user can't dismiss it, so they need to see the reason on the form.
      const msg = err.response?.data?.error || 'Failed to update password';
      setServerError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  // When `forced` is true the user authenticated with a known-default password
  // and isn't allowed to dismiss the dialog without rotating. Block the
  // backdrop close, hide the Cancel button, and add a banner.
  return (
    <Dialog
      open={open}
      onClose={() => { if (!saving && !forced) onClose(); }}
      maxWidth="xs"
      fullWidth
      disableEscapeKeyDown={forced}
    >
      <DialogTitle>{forced ? 'Set a new password' : 'Change Password'}</DialogTitle>
      <DialogContent>
        {forced && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            You signed in with a well-known default password. Choose a new one
            before continuing — the API will refuse to keep using it.
          </Alert>
        )}
        {serverError && <Alert severity="error" sx={{ mb: 2 }}>{serverError}</Alert>}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
          <TextField label="New password" type="password" size="small" required
            value={next} onChange={e => setNext(e.target.value)}
            helperText="At least 6 characters and not on the default-password block list."
            inputProps={{ autoComplete: 'new-password' }}
            autoFocus />
          <TextField label="Confirm new password" type="password" size="small" required
            value={confirm} onChange={e => setConfirm(e.target.value)}
            error={confirm.length > 0 && next !== confirm}
            helperText={confirm.length > 0 && next !== confirm ? 'Passwords do not match' : ''}
            inputProps={{ autoComplete: 'new-password' }}
            onKeyDown={e => { if (e.key === 'Enter' && canSubmit) handleSubmit(); }} />
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        {!forced && <Button onClick={onClose} disabled={saving}>Cancel</Button>}
        <Button variant="contained" onClick={handleSubmit} disabled={!canSubmit}>
          {saving ? 'Updating…' : 'Update password'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function ThemeToggleMenuItem({ onClose }: { onClose: () => void }) {
  const { mode, toggle } = useThemeMode();
  const isDark = mode === 'dark';
  return (
    <MenuItem onClick={() => { toggle(); onClose(); }}>
      {isDark
        ? <><LightModeIcon sx={{ mr: 1, fontSize: 18 }} /> Switch to light mode</>
        : <><DarkModeIcon sx={{ mr: 1, fontSize: 18 }} /> Switch to dark mode</>}
    </MenuItem>
  );
}

// Main Layout
function MainLayout({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const navigate = useNavigate();
  // Tiered feed status: 'healthy' / 'lagging' / 'stale' / 'unknown' from
  // /api/health. The top-bar chip used to be a binary green/red and stayed
  // green up to the 25 min DEGRADED cutoff — operators saw "OK" while the
  // feed silently aged into 11 min stale. Now it surfaces the intermediate
  // states explicitly.
  const [feedTier, setFeedTier] = useState<string | null>(null);
  const [feedAgeMin, setFeedAgeMin] = useState<number | null>(null);
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  // Force the change-password dialog open if the login response told us this
  // session is still on a default password. The dialog refuses to close until
  // a non-banned password is set.
  const [changePwOpen, setChangePwOpen] = useState(!!user.must_change_password);
  const [changePwForced, setChangePwForced] = useState(!!user.must_change_password);
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));

  useEffect(() => {
    const check = async () => {
      try {
        const res = await getHealth();
        // Fall back to feedHealthy for older API builds that don't emit feedTier.
        setFeedTier(res.data.feedTier ?? (res.data.feedHealthy ? 'healthy' : 'stale'));
        setFeedAgeMin(typeof res.data.dataAgeMinutes === 'number' ? res.data.dataAgeMinutes : null);
      } catch {
        setFeedTier('unknown');
        setFeedAgeMin(null);
      }
    };
    check();
    const interval = setInterval(check, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <UserContext.Provider value={user}>
    <OrgScopeProvider>
    <Box sx={{ display: 'flex', minHeight: '100vh', width: '100%' }}>
      <NavSidebar mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} user={user} />
      <Box sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <AppBar position="static" color="transparent" elevation={0}
          sx={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <Toolbar>
            {isMobile && (
              <IconButton edge="start" color="inherit" onClick={() => setMobileOpen(true)} sx={{ mr: 1 }}>
                <MenuIcon />
              </IconButton>
            )}
            <Typography variant="h6" sx={{ flexGrow: 1, fontSize: { xs: 13, sm: 16 } }} noWrap>
              {isMobile ? 'FlashAware' : 'South Africa FlashAware Monitor'}
            </Typography>
            {feedTier && feedTier !== 'healthy' && (() => {
              // Clickable for super_admin (jumps to the EUMETSAT Feed card on
              // /platform); a passive tooltip for everyone else, since they
              // don't have a Platform page to land on.
              const canDrill = user.role === 'super_admin';
              const baseTitle =
                feedTier === 'lagging'
                  ? 'Data 3–10 min old. Engine still evaluates normally; treat decisions with caution until the feed catches up.'
                  : feedTier === 'stale'
                    ? 'Data > 10 min old. Engine still tolerates up to 25 min before flipping every site to NO DATA FEED.'
                    : 'No recent data. Risk cannot be determined; locations will surface as NO DATA FEED.';
              return (
                <Chip
                  label={
                    feedTier === 'lagging' ? `⚠ FEED LAGGING${feedAgeMin != null ? ` (${feedAgeMin} min)` : ''}`
                    : feedTier === 'stale' ? `⚠ FEED STALE${feedAgeMin != null ? ` (${feedAgeMin} min)` : ''}`
                    : '⚠ NO FEED'
                  }
                  color={feedTier === 'lagging' ? 'warning' : 'error'}
                  size="small"
                  clickable={canDrill}
                  onClick={canDrill ? () => navigate('/platform#eumetsat-feed') : undefined}
                  title={canDrill ? `${baseTitle} Click to inspect EUMETSAT feed health.` : baseTitle}
                  aria-label={canDrill ? 'Open EUMETSAT feed health on the Platform overview' : undefined}
                  sx={{
                    mr: 1,
                    fontWeight: 600,
                    fontSize: { xs: 10, sm: 12 },
                    height: { xs: 22, sm: 24 },
                    cursor: canDrill ? 'pointer' : 'default',
                  }}
                />
              );
            })()}
            <OrgPicker />
            <IconButton onClick={e => setAnchorEl(e.currentTarget)}>
              <Avatar sx={{ width: 32, height: 32, bgcolor: 'primary.main', fontSize: 14 }}>
                {user.name.charAt(0)}
              </Avatar>
            </IconButton>
            <Menu anchorEl={anchorEl} open={!!anchorEl} onClose={() => setAnchorEl(null)}>
              <MenuItem disabled sx={{ opacity: '1 !important' }}>
                <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <Typography variant="body2" fontWeight={600} noWrap>{user.name}</Typography>
                  <Typography variant="caption" color="text.secondary" noWrap>
                    {user.role}{user.org_name ? ` · ${user.org_name}` : ''}
                  </Typography>
                </Box>
              </MenuItem>
              <Divider />
              <MenuItem onClick={() => { setChangePwOpen(true); setChangePwForced(false); setAnchorEl(null); }}>
                <KeyIcon sx={{ mr: 1, fontSize: 18 }} /> Change password
              </MenuItem>
              <ThemeToggleMenuItem onClose={() => setAnchorEl(null)} />
              <Divider />
              <MenuItem onClick={onLogout}>
                <LogoutIcon sx={{ mr: 1, fontSize: 18 }} /> Sign Out
              </MenuItem>
            </Menu>
            <ChangePasswordDialog
              open={changePwOpen}
              forced={changePwForced}
              onClose={() => { setChangePwOpen(false); setChangePwForced(false); }}
              userId={user.id}
            />
          </Toolbar>
        </AppBar>
        <OrgScopeBanner />
        <Box sx={{ flexGrow: 1, p: { xs: 1.5, sm: 2, md: 3 }, overflowX: 'hidden' }}>
          <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/locations" element={<LocationEditor />} />
              <Route path="/alerts" element={<AlertHistory />} />
              <Route path="/replay" element={<Replay />} />
              {/* /users is a per-org flat list. super_admin manages users
                  inside the per-org expander on /orgs, so the flat view (which
                  ignores the org-scope picker) would otherwise leak the wrong
                  tenant's users. Redirect them. */}
              <Route
                path="/users"
                element={user.role === 'super_admin' ? <Navigate to="/orgs" replace /> : <UserManagement />}
              />
              <Route path="/audit" element={<AuditLog />} />
              <Route path="/settings" element={<Settings />} />
              {user.role === 'super_admin' && <Route path="/platform" element={<PlatformOverview />} />}
              {user.role === 'super_admin' && <Route path="/orgs" element={<OrgManagement />} />}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
        </Box>
      </Box>
    </Box>
    </OrgScopeProvider>
    </UserContext.Provider>
  );
}


// Root App
export default function App() {
  const [user, setUser] = useState<AuthUser | null>(() => {
    const stored = localStorage.getItem('flashaware_user');
    return stored ? JSON.parse(stored) : null;
  });
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('flashaware_token'));
  const [mode, setMode] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem('flashaware_theme');
    return saved === 'light' || saved === 'dark' ? saved : 'dark';
  });

  const themeMode = useMemo(() => ({
    mode,
    toggle: () => setMode(m => {
      const next = m === 'dark' ? 'light' : 'dark';
      localStorage.setItem('flashaware_theme', next);
      return next;
    }),
  }), [mode]);

  const activeTheme = mode === 'dark' ? darkTheme : lightTheme;

  const handleLogin = (nextUser: AuthUser, nextToken: string) => {
    // Clear any previous super_admin's tenant scope when a different identity
    // signs in on the same browser. Without this, the scope picker would leak
    // across sessions and writes could land in the wrong tenant.
    if (user && user.id !== nextUser.id) {
      localStorage.removeItem(SCOPED_ORG_STORAGE_KEY);
    }
    setUser(nextUser);
    setToken(nextToken);
    // Strip the one-shot `must_change_password` signal before persisting so
    // a page reload after the user has rotated their password doesn't
    // re-trigger the forced dialog. The in-memory copy still has the flag,
    // which is exactly what MainLayout reads on first mount.
    const { must_change_password, ...persistable } = nextUser;
    localStorage.setItem('flashaware_user', JSON.stringify(persistable));
    localStorage.setItem('flashaware_token', nextToken);
  };

  const handleLogout = () => {
    setUser(null);
    setToken(null);
    localStorage.removeItem('flashaware_user');
    localStorage.removeItem('flashaware_token');
    localStorage.removeItem(SCOPED_ORG_STORAGE_KEY);
  };

  return (
    <ThemeModeContext.Provider value={themeMode}>
      <ThemeProvider theme={activeTheme}>
        <CssBaseline />
        <ToastProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/register" element={<Register />} />
              <Route path="*" element={
                user && token
                  ? <MainLayout user={user} onLogout={handleLogout} />
                  : <LoginPage onLogin={handleLogin} />
              } />
            </Routes>
          </BrowserRouter>
        </ToastProvider>
      </ThemeProvider>
    </ThemeModeContext.Provider>
  );
}

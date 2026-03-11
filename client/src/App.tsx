import React, { useState, useEffect, useMemo } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Link, useLocation, useNavigate } from 'react-router-dom';
import {
  ThemeProvider, createTheme, CssBaseline, Box, AppBar, Toolbar, Typography,
  Drawer, List, ListItemButton, ListItemIcon, ListItemText, Divider, Chip,
  IconButton, Avatar, Menu, MenuItem, TextField, Button, Paper, Alert,
  useMediaQuery, useTheme,
} from '@mui/material';
import DashboardIcon from '@mui/icons-material/Dashboard';
import LocationOnIcon from '@mui/icons-material/LocationOn';
import NotificationsIcon from '@mui/icons-material/Notifications';
import ReplayIcon from '@mui/icons-material/Replay';
import SettingsIcon from '@mui/icons-material/Settings';
import LogoutIcon from '@mui/icons-material/Logout';
import FlashOnIcon from '@mui/icons-material/FlashOn';
import PeopleIcon from '@mui/icons-material/People';
import MenuIcon from '@mui/icons-material/Menu';
import BusinessIcon from '@mui/icons-material/Business';

import Dashboard from './Dashboard';
import LocationEditor from './LocationEditor';
import AlertHistory from './AlertHistory';
import Replay from './Replay';
import Settings from './Settings';
import UserManagement from './UserManagement';
import OrgManagement from './OrgManagement';
import Register from './Register';
import { loginApi, getHealth } from './api';

const DRAWER_WIDTH = 240;

const darkTheme = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: '#fbc02d' },
    secondary: { main: '#ef6c00' },
    background: { default: '#0a1929', paper: '#132f4c' },
    success: { main: '#2e7d32' },
    warning: { main: '#ed6c02' },
    error: { main: '#d32f2f' },
  },
  typography: {
    fontFamily: '"Inter", "Roboto", "Helvetica", "Arial", sans-serif',
    h4: { fontWeight: 700 },
    h5: { fontWeight: 600 },
    h6: { fontWeight: 600 },
  },
  shape: { borderRadius: 12 },
  components: {
    MuiCard: {
      styleOverrides: {
        root: { backgroundImage: 'none' },
      },
    },
  },
});

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
}

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
          <FlashOnIcon sx={{ fontSize: 48, color: 'primary.main' }} />
          <Typography variant="h5" sx={{ mt: 1 }}>FlashAware System</Typography>
          <Typography variant="body2" color="text.secondary">Sign in to continue</Typography>
        </Box>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        <form onSubmit={handleSubmit}>
          <TextField fullWidth label="Email" value={email} onChange={e => setEmail(e.target.value)}
            sx={{ mb: 2 }} size="small" />
          <TextField fullWidth label="Password" type="password" value={password}
            onChange={e => setPassword(e.target.value)} sx={{ mb: 3 }} size="small" />
          <Button fullWidth variant="contained" type="submit" disabled={loading} size="large">
            {loading ? 'Signing in…' : 'Sign In'}
          </Button>
        </form>
      </Paper>
    </Box>
  );
}

// Navigation Sidebar
function NavSidebar({ feedHealthy, mobileOpen, onMobileClose, user }: { feedHealthy: boolean | null; mobileOpen: boolean; onMobileClose: () => void; user: AuthUser }) {
  const location = useLocation();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const navItems = [
    { path: '/', label: 'Dashboard', icon: <DashboardIcon /> },
    { path: '/locations', label: 'Locations', icon: <LocationOnIcon /> },
    { path: '/alerts', label: 'Alert History', icon: <NotificationsIcon /> },
    { path: '/replay', label: 'Replay', icon: <ReplayIcon /> },
    { path: '/users', label: 'Users', icon: <PeopleIcon /> },
    { path: '/settings', label: 'Settings', icon: <SettingsIcon /> },
    ...(user.role === 'super_admin' ? [{ path: '/orgs', label: 'Organisations', icon: <BusinessIcon /> }] : []),
  ];

  const drawerContent = (
    <>
      <Toolbar sx={{ gap: 1 }}>
        <FlashOnIcon sx={{ color: 'primary.main' }} />
        <Typography variant="h6" noWrap sx={{ fontSize: 16 }}>FlashAware</Typography>
      </Toolbar>
      <Divider />
      <List sx={{ px: 1 }}>
        {navItems.map(item => (
          <ListItemButton key={item.path} component={Link} to={item.path}
            selected={location.pathname === item.path}
            onClick={isMobile ? onMobileClose : undefined}
            sx={{ borderRadius: 2, mb: 0.5 }}>
            <ListItemIcon sx={{ minWidth: 40 }}>{item.icon}</ListItemIcon>
            <ListItemText primary={item.label} primaryTypographyProps={{ fontSize: 14 }} />
          </ListItemButton>
        ))}
      </List>
      <Box sx={{ mt: 'auto', p: 2 }}>
        <Chip
          label={feedHealthy === null ? 'Checking…' : feedHealthy ? 'Feed Healthy' : 'Feed Degraded'}
          color={feedHealthy === null ? 'default' : feedHealthy ? 'success' : 'error'}
          size="small"
          sx={{ width: '100%' }}
        />
      </Box>
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

// Main Layout
function MainLayout({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const [feedHealthy, setFeedHealthy] = useState<boolean | null>(null);
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));

  useEffect(() => {
    const check = async () => {
      try {
        const res = await getHealth();
        setFeedHealthy(res.data.feedHealthy);
      } catch {
        setFeedHealthy(false);
      }
    };
    check();
    const interval = setInterval(check, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', width: '100%' }}>
      <NavSidebar feedHealthy={feedHealthy} mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} user={user} />
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
            {!feedHealthy && feedHealthy !== null && (
              <Chip label="⚠ DATA DEGRADED" color="error" size="small" sx={{ mr: 1, fontWeight: 600, display: { xs: 'none', sm: 'flex' } }} />
            )}
            <IconButton onClick={e => setAnchorEl(e.currentTarget)}>
              <Avatar sx={{ width: 32, height: 32, bgcolor: 'primary.main', fontSize: 14 }}>
                {user.name.charAt(0)}
              </Avatar>
            </IconButton>
            <Menu anchorEl={anchorEl} open={!!anchorEl} onClose={() => setAnchorEl(null)}>
              <MenuItem disabled>
                <Typography variant="body2">{user.name} ({user.role})</Typography>
              </MenuItem>
              <Divider />
              <MenuItem onClick={onLogout}>
                <LogoutIcon sx={{ mr: 1, fontSize: 18 }} /> Sign Out
              </MenuItem>
            </Menu>
          </Toolbar>
        </AppBar>
        <Box sx={{ flexGrow: 1, p: { xs: 1.5, sm: 2, md: 3 }, overflowX: 'hidden' }}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/locations" element={<LocationEditor />} />
            <Route path="/alerts" element={<AlertHistory />} />
            <Route path="/replay" element={<Replay />} />
            <Route path="/users" element={<UserManagement />} />
            <Route path="/settings" element={<Settings />} />
            {user.role === 'super_admin' && <Route path="/orgs" element={<OrgManagement />} />}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Box>
      </Box>
    </Box>
  );
}


// Root App
export default function App() {
  const [user, setUser] = useState<AuthUser | null>(() => {
    const stored = localStorage.getItem('flashaware_user');
    return stored ? JSON.parse(stored) : null;
  });
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('flashaware_token'));

  const handleLogin = (user: AuthUser, token: string) => {
    setUser(user);
    setToken(token);
    localStorage.setItem('flashaware_user', JSON.stringify(user));
    localStorage.setItem('flashaware_token', token);
  };

  const handleLogout = () => {
    setUser(null);
    setToken(null);
    localStorage.removeItem('flashaware_user');
    localStorage.removeItem('flashaware_token');
  };

  return (
    <ThemeProvider theme={darkTheme}>
      <CssBaseline />
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
    </ThemeProvider>
  );
}

import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 15000,
});

// Auth interceptor — attach JWT token to all requests
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('flashaware_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Response interceptor — handle 401 by redirecting to login
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('flashaware_token');
      localStorage.removeItem('flashaware_user');
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

// Auth
export const loginApi = (email: string, password: string) =>
  api.post('/auth/login', { email, password });

// Health
export const getHealth = () => api.get('/health');

// Onboarding — drives the Dashboard SetupChecklist.
export const getOnboardingState = () => api.get<{ hasLocation: boolean; hasRecipient: boolean; hasVerifiedPhone: boolean }>('/onboarding/state');

// Locations
// orgId is super_admin-only — passing it as a non-super_admin returns 403.
export const getLocations = (orgId?: string) =>
  api.get('/locations', { params: orgId ? { org_id: orgId } : undefined });
export const createLocation = (data: any) => api.post('/locations', data);
export const updateLocation = (id: string, data: any) => api.put(`/locations/${id}`, data);
export const deleteLocation = (id: string) => api.delete(`/locations/${id}`);

// Status
export const getStatus = (orgId?: string) =>
  api.get('/status', { params: orgId ? { org_id: orgId } : undefined });
export const getLocationStatus = (id: string) => api.get(`/status/${id}`);

// Organisations (super_admin only — returned 403 for everyone else)
export const getOrganisations = () => api.get('/orgs');

// Platform overview (super_admin only)
export const getPlatformOverview = () => api.get('/platform/overview');

// Audit log (admin sees own org; super_admin sees all or scoped via org_id)
export interface AuditFilters {
  org_id?: string;
  action?: string;
  action_prefix?: string;
  target_type?: string;
  target_id?: string;
  actor_user_id?: string;
  actor_email?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}
export const getAuditLog = (filters?: AuditFilters) => api.get('/audit', { params: filters });

// Flashes
export const getFlashes = (params?: { west?: number; south?: number; east?: number; north?: number; minutes?: number }) =>
  api.get('/flashes', { params });

// Alerts
// org_id is super_admin-only.
export const getAlerts = (params?: { location_id?: string; limit?: number; offset?: number; org_id?: string }) =>
  api.get('/alerts', { params });
export const acknowledgeAlert = (alertId: string) => api.post(`/ack/${alertId}`);

// Replay
export const getReplay = (locationId: string, hours?: number) =>
  api.get(`/replay/${locationId}`, { params: { hours } });

// Notification Recipients
export const getRecipients = (locationId: string) =>
  api.get(`/locations/${locationId}/recipients`);
export const addRecipient = (locationId: string, data: { email: string; phone?: string; notify_email?: boolean; notify_sms?: boolean; notify_whatsapp?: boolean }) =>
  api.post(`/locations/${locationId}/recipients`, data);
export const updateRecipient = (locationId: string, recipientId: number, data: { email?: string; phone?: string; active?: boolean; notify_email?: boolean; notify_sms?: boolean; notify_whatsapp?: boolean }) =>
  api.put(`/locations/${locationId}/recipients/${recipientId}`, data);
export const deleteRecipient = (locationId: string, recipientId: number) =>
  api.delete(`/locations/${locationId}/recipients/${recipientId}`);

// Phone OTP verification — recipients with phone numbers must verify before
// SMS/WhatsApp dispatch is unlocked.
export const sendRecipientOtp = (locationId: string, recipientId: number) =>
  api.post(`/locations/${locationId}/recipients/${recipientId}/send-otp`);
export const verifyRecipientOtp = (locationId: string, recipientId: number, code: string) =>
  api.post(`/locations/${locationId}/recipients/${recipientId}/verify-otp`, { code });

// Users
export const resetUserPassword = (userId: string, password: string) =>
  api.post(`/users/${userId}/reset-password`, { password });

// Per-org settings (caller's own org by default; super_admin can pass orgId).
export const getSettings = (orgId?: string) =>
  api.get('/settings', { params: orgId ? { org_id: orgId } : undefined });
export const saveSettings = (data: Record<string, string | boolean | number>, orgId?: string) =>
  api.post('/settings', data, { params: orgId ? { org_id: orgId } : undefined });

// Platform-wide defaults — super_admin only.
export const getPlatformSettings = () => api.get('/platform-settings');
export const savePlatformSettings = (data: Record<string, string | boolean | number>) =>
  api.post('/platform-settings', data);

export default api;

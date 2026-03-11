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

// Locations
export const getLocations = () => api.get('/locations');
export const createLocation = (data: any) => api.post('/locations', data);
export const updateLocation = (id: string, data: any) => api.put(`/locations/${id}`, data);
export const deleteLocation = (id: string) => api.delete(`/locations/${id}`);

// Status
export const getStatus = () => api.get('/status');
export const getLocationStatus = (id: string) => api.get(`/status/${id}`);

// Flashes
export const getFlashes = (params?: { west?: number; south?: number; east?: number; north?: number; minutes?: number }) =>
  api.get('/flashes', { params });

// Alerts
export const getAlerts = (params?: { location_id?: string; limit?: number; offset?: number }) =>
  api.get('/alerts', { params });
export const acknowledgeAlert = (alertId: string) => api.post(`/ack/${alertId}`);

// Replay
export const getReplay = (locationId: string, hours?: number) =>
  api.get(`/replay/${locationId}`, { params: { hours } });

// Notification Recipients
export const getRecipients = (locationId: string) =>
  api.get(`/locations/${locationId}/recipients`);
export const addRecipient = (locationId: string, data: { email: string; phone?: string; notify_sms?: boolean; notify_whatsapp?: boolean }) =>
  api.post(`/locations/${locationId}/recipients`, data);
export const updateRecipient = (locationId: string, recipientId: number, data: { email?: string; phone?: string; active?: boolean; notify_sms?: boolean; notify_whatsapp?: boolean }) =>
  api.put(`/locations/${locationId}/recipients/${recipientId}`, data);
export const deleteRecipient = (locationId: string, recipientId: number) =>
  api.delete(`/locations/${locationId}/recipients/${recipientId}`);

export default api;

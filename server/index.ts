import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { createServer } from 'http';
import rateLimit from 'express-rate-limit';
import { authenticate, requireRole, login, loginRateLimit, AuthRequest } from './auth';
import { startRiskEngine } from './riskEngine';
import { acknowledgeAlert, checkEscalations, getTransporter, buildEmailHtml } from './alertService';
import {
  getAllLocations,
  getAllLocationsAdmin,
  getRecentFlashes,
  getLatestRiskState,
  getLatestIngestionTime,
  createLocation,
  deleteLocation,
  updateLocation,
  getLocationById,
  getAlerts,
  getAllRiskStates,
  getRecentRiskStates,
  getLocationRecipients,
  addLocationRecipient,
  updateLocationRecipient,
  deleteLocationRecipient,
  getLocationRecipientById,
  updateAlertStatus,
  getAppSettings,
  setAppSetting,
} from './queries';
import { hasCredentials, startLiveIngestion } from './eumetsatService';
import { logger } from './logger';
import { wsManager } from './websocket';
import userRoutes from './userRoutes';
import orgRoutes from './orgRoutes';
import { runMigrations } from './migrate';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// Parse WKT "POINT(lng lat)" into { lng, lat } numbers
function parseCentroid(wkt: string | null | undefined): { lng: number; lat: number } {
  if (!wkt) return { lng: 0, lat: 0 };
  const m = wkt.match(/POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/i);
  if (!m) return { lng: 0, lat: 0 };
  return { lng: parseFloat(m[1]), lat: parseFloat(m[2]) };
}

const app = express();
const server = createServer(app);
const PORT = parseInt(process.env.SERVER_PORT || '4000');

// Trust Fly.io's reverse proxy so rate limiting uses real client IPs
app.set('trust proxy', 1);

// Initialize WebSocket
wsManager.initialize(server);

// Rate limiting for all API endpoints
const apiRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // limit each IP to 1000 requests per window
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(cors({
  origin: process.env.CORS_ORIGIN || true,
  credentials: true,
}));
app.use(express.json());
app.use(apiRateLimit);

// Initialize in-memory data (users + locations always; mock flashes only if no live credentials)
const liveMode = hasCredentials();
logger.info(`Initializing data (${liveMode ? 'LIVE EUMETSAT' : 'mock'} mode)...`);

// ============================================================
// Public endpoints
// ============================================================

app.get('/api/health', async (_req, res) => {
  try {
    // Lightweight DB ping only — no heavy queries
    const { query: dbQuery } = await import('./db');
    await dbQuery('SELECT 1');

    // Best-effort enrichment (non-blocking, won't fail health check)
    let extra: Record<string, unknown> = {};
    try {
      const [latestProduct, locations, recentRiskStates] = await Promise.all([
        getLatestIngestionTime(),
        getAllLocations('00000000-0000-0000-0000-000000000001'),
        getAllRiskStates(1),
      ]);
      const dataAgeMin = latestProduct
        ? Math.floor((Date.now() - latestProduct.getTime()) / 60000)
        : null;
      extra = {
        lastIngestion: latestProduct?.toISOString() || null,
        dataAgeMinutes: dataAgeMin,
        feedHealthy: dataAgeMin !== null && dataAgeMin < 25,
        locationCount: locations.length,
        recentEvaluations: recentRiskStates.length,
        websocketConnections: wsManager.getStats().connectedClients,
      };
    } catch (_) { /* enrichment failed — still healthy */ }

    res.json({
      status: 'ok',
      db: true,
      mode: hasCredentials() ? 'live-eumetsat' : 'in-memory-mock',
      serverTime: new Date().toISOString(),
      ...extra,
    });
  } catch (error) {
    logger.error('Health check failed', { error: (error as Error).message });
    res.status(500).json({
      status: 'error',
      error: 'Health check failed',
      db: false,
    });
  }
});

app.get('/api/health/feed', async (_req, res) => {
  try {
    const { query: dbQuery } = await import('./db');
    await dbQuery('SELECT 1');
    const latestProduct = await getLatestIngestionTime();
    const dataAgeMin = latestProduct
      ? Math.floor((Date.now() - latestProduct.getTime()) / 60000)
      : null;
    const feedHealthy = dataAgeMin !== null && dataAgeMin < 25;
    const status = feedHealthy ? 'ok' : 'degraded';
    res.status(feedHealthy ? 200 : 503).json({
      status,
      feedHealthy,
      dataAgeMinutes: dataAgeMin,
      lastIngestion: latestProduct?.toISOString() || null,
      threshold_min: 25,
    });
  } catch (error) {
    res.status(503).json({ status: 'error', feedHealthy: false, error: (error as Error).message });
  }
});

app.post('/api/webhooks/twilio-status', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const { MessageSid, MessageStatus, ErrorCode, ErrorMessage } = req.body;
    if (MessageSid && MessageStatus) {
      const error = ErrorCode ? `${ErrorCode}${ErrorMessage ? ': ' + ErrorMessage : ''}` : null;
      await updateAlertStatus(MessageSid, MessageStatus, error);
      logger.info('Twilio status callback', { MessageSid, MessageStatus, ErrorCode });
    }
    res.sendStatus(204);
  } catch (err) {
    logger.error('Twilio status webhook error', { error: (err as Error).message });
    res.sendStatus(500);
  }
});

app.post('/api/auth/login', loginRateLimit, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  
  const result = await login(email, password);
  if (!result) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  
  res.json(result);
});

// ============================================================
// Protected endpoints
// ============================================================

// -- Users --
app.use('/api/users', userRoutes);

// -- Organisations & Invites --
app.use('/api/orgs', orgRoutes);

// -- Locations --
app.get('/api/locations', authenticate, requireRole('viewer'), async (_req: AuthRequest, res) => {
  try {
    const locations = await getAllLocationsAdmin((_req.user!.org_id));
    const result = await Promise.all(
      locations.map(async (loc) => {
        const rs = await getLatestRiskState(loc.id);
        const { lng, lat } = parseCentroid(loc.centroid);
        return {
          ...loc,
          lng,
          lat,
          current_state: rs?.state || null,
          state_evaluated_at: rs?.evaluated_at || null,
          state_reason: rs?.reason || null,
          nearest_flash_km: rs?.nearest_flash_km ?? null,
          flashes_in_stop_radius: rs?.flashes_in_stop_radius ?? null,
          flashes_in_prepare_radius: rs?.flashes_in_prepare_radius ?? null,
        };
      })
    );
    
    res.json(result.sort((a, b) => a.name.localeCompare(b.name)));
  } catch (error) {
    logger.error('Failed to get locations', { error: (error as Error).message });
    res.status(500).json({ error: 'Failed to get locations' });
  }
});

app.post('/api/locations', authenticate, requireRole('admin'), async (req: AuthRequest, res) => {
  try {
    const { name, site_type, centroid, timezone, thresholds } = req.body;
    
    // Create PostGIS geometries
    const geom = `POLYGON((${
      centroid.lng - 0.01 } ${ centroid.lat - 0.01 }, ${
      centroid.lng + 0.01 } ${ centroid.lat - 0.01 }, ${
      centroid.lng + 0.01 } ${ centroid.lat + 0.01 }, ${
      centroid.lng - 0.01 } ${ centroid.lat + 0.01 }, ${
      centroid.lng - 0.01 } ${ centroid.lat - 0.01 }))`;
    const centroidWkt = `POINT(${centroid.lng} ${centroid.lat})`;
    
    const newLoc = await createLocation({
      name,
      site_type: site_type || 'other',
      geom,
      centroid: centroidWkt,
      org_id: req.user!.org_id,
      timezone: timezone || 'Africa/Johannesburg',
      stop_radius_km: thresholds?.stop_radius_km ?? 10,
      prepare_radius_km: thresholds?.prepare_radius_km ?? 20,
      stop_flash_threshold: thresholds?.stop_flash_threshold ?? 1,
      stop_window_min: thresholds?.stop_window_min ?? 15,
      prepare_flash_threshold: thresholds?.prepare_flash_threshold ?? 1,
      prepare_window_min: thresholds?.prepare_window_min ?? 15,
      allclear_wait_min: thresholds?.allclear_wait_min ?? 30,
      persistence_alert_min: thresholds?.persistence_alert_min ?? 10,
    });
    
    logger.info('Location created', {
      locationId: newLoc.id,
      locationName: newLoc.name,
      createdBy: req.user?.id
    });
    
    res.status(201).json({ id: newLoc.id });
  } catch (error) {
    logger.error('Failed to create location', { 
      error: (error as Error).message,
      requestedBy: req.user?.id 
    });
    res.status(500).json({ error: 'Failed to create location' });
  }
});

app.put('/api/locations/:id', authenticate, requireRole('admin'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { name, site_type, centroid, timezone, thresholds, enabled } = req.body;
    
    const existingLoc = await getLocationById(id);
    if (!existingLoc) {
      return res.status(404).json({ error: 'Location not found' });
    }
    
    // Update geometry if centroid provided
    let updates: any = {};
    if (name !== undefined) updates.name = name;
    if (site_type !== undefined) updates.site_type = site_type;
    if (centroid) {
      const geom = `POLYGON((${
        centroid.lng - 0.01 } ${ centroid.lat - 0.01 }, ${
        centroid.lng + 0.01 } ${ centroid.lat - 0.01 }, ${
        centroid.lng + 0.01 } ${ centroid.lat + 0.01 }, ${
        centroid.lng - 0.01 } ${ centroid.lat + 0.01 }, ${
        centroid.lng - 0.01 } ${ centroid.lat - 0.01 }))`;
      const centroidWkt = `POINT(${centroid.lng} ${centroid.lat})`;
      updates.geom = geom;
      updates.centroid = centroidWkt;
    }
    if (timezone !== undefined) updates.timezone = timezone;
    if (thresholds?.stop_radius_km !== undefined) updates.stop_radius_km = thresholds.stop_radius_km;
    if (thresholds?.prepare_radius_km !== undefined) updates.prepare_radius_km = thresholds.prepare_radius_km;
    if (thresholds?.stop_flash_threshold !== undefined) updates.stop_flash_threshold = thresholds.stop_flash_threshold;
    if (thresholds?.stop_window_min !== undefined) updates.stop_window_min = thresholds.stop_window_min;
    if (thresholds?.prepare_flash_threshold !== undefined) updates.prepare_flash_threshold = thresholds.prepare_flash_threshold;
    if (thresholds?.prepare_window_min !== undefined) updates.prepare_window_min = thresholds.prepare_window_min;
    if (thresholds?.allclear_wait_min !== undefined) updates.allclear_wait_min = thresholds.allclear_wait_min;
    if (thresholds?.persistence_alert_min !== undefined) updates.persistence_alert_min = thresholds.persistence_alert_min;
    if (enabled !== undefined) updates.enabled = enabled;
    
    const updatedLoc = await updateLocation(id, updates);
    
    logger.info('Location updated', {
      locationId: id,
      updatedBy: req.user?.id,
      fields: Object.keys(updates)
    });
    
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to update location', { 
      error: (error as Error).message,
      requestedBy: req.user?.id,
      locationId: req.params.id
    });
    res.status(500).json({ error: 'Failed to update location' });
  }
});

app.delete('/api/locations/:id', authenticate, requireRole('admin'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const existing = await getLocationById(id);
    if (!existing) return res.status(404).json({ error: 'Location not found' });
    const deleted = await deleteLocation(id);
    if (!deleted) return res.status(500).json({ error: 'Delete failed' });
    logger.info('Location deleted', { locationId: id, deletedBy: req.user?.id });
    res.status(204).send();
  } catch (error) {
    logger.error('Failed to delete location', { error: (error as Error).message, locationId: req.params.id });
    res.status(500).json({ error: 'Failed to delete location' });
  }
});

// -- App Settings --
app.get('/api/settings', authenticate, requireRole('admin'), async (_req: AuthRequest, res) => {
  try {
    const settings = await getAppSettings();
    res.json(settings);
  } catch (error) {
    logger.error('Failed to get settings', { error: (error as Error).message });
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

app.post('/api/settings', authenticate, requireRole('admin'), async (req: AuthRequest, res) => {
  try {
    const allowed = ['email_enabled', 'sms_enabled', 'escalation_enabled', 'escalation_delay_min', 'alert_from_address'];
    const updates = Object.entries(req.body as Record<string, string>)
      .filter(([k]) => allowed.includes(k));
    await Promise.all(updates.map(([k, v]) => setAppSetting(k, String(v))));
    logger.info('App settings updated', { keys: updates.map(([k]) => k), by: req.user?.id });
    res.json({ ok: true });
  } catch (error) {
    logger.error('Failed to save settings', { error: (error as Error).message });
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// -- Test Email --
app.post('/api/test-email', authenticate, requireRole('admin'), async (req: AuthRequest, res) => {
  const { to } = req.body;
  if (!to || !to.includes('@')) return res.status(400).json({ error: 'Valid "to" email is required' });
  try {
    await getTransporter().sendMail({
      from: process.env.ALERT_FROM || 'alerts@flashaware.com',
      to,
      subject: '🟢 FlashAware — Test Alert Email',
      html: buildEmailHtml('Test Location', 'ALL_CLEAR', 'This is a test email to confirm your alert notifications are working correctly.'),
    });
    logger.info('Test email sent', { to, by: req.user?.id });
    res.json({ ok: true, message: `Test email sent to ${to}` });
  } catch (error) {
    logger.error('Test email failed', { error: (error as Error).message, to });
    res.status(500).json({ error: (error as Error).message });
  }
});

async function sendWhatsAppOptInSms(phone: string): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  const waNumber = process.env.TWILIO_WHATSAPP_FROM || from;
  if (!sid || !token || !from || !phone) return;
  try {
    const twilio = (await import('twilio')).default;
    const client = twilio(sid, token);
    await client.messages.create({
      from,
      to: phone,
      body: `FlashAware: You've been added as a lightning risk alert recipient. To receive WhatsApp alerts, send any message to +${waNumber?.replace(/\D/g, '')} on WhatsApp (one-time setup). Reply STOP to opt out of SMS.`,
    });
    logger.info('WhatsApp opt-in SMS sent', { phone });
  } catch (err) {
    logger.warn('WhatsApp opt-in SMS failed (non-critical)', { phone, error: (err as Error).message });
  }
}

// -- Location Recipients --
app.get('/api/locations/:id/recipients', authenticate, requireRole('viewer'), async (req, res) => {
  try {
    const recipients = await getLocationRecipients(req.params.id);
    res.json(recipients);
  } catch (error) {
    logger.error('Failed to get recipients', { error: (error as Error).message, locationId: req.params.id });
    res.status(500).json({ error: 'Failed to get recipients' });
  }
});

app.post('/api/locations/:id/recipients', authenticate, requireRole('admin'), async (req: AuthRequest, res) => {
  try {
    const { email, phone } = req.body;
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }
    const locationId = req.params.id;
    const loc = await getLocationById(locationId);
    if (!loc) return res.status(404).json({ error: 'Location not found' });

    const { notify_email, notify_sms, notify_whatsapp } = req.body;
    const id = await addLocationRecipient({ location_id: locationId, email: email.trim().toLowerCase(), phone: phone || null, active: true, notify_email: notify_email !== false, notify_sms: !!notify_sms, notify_whatsapp: !!notify_whatsapp });
    logger.info('Recipient added', { locationId, email, by: req.user?.id });
    if (notify_whatsapp && phone) {
      sendWhatsAppOptInSms(phone).catch(() => {});
    }
    res.status(201).json({ id });
  } catch (error) {
    logger.error('Failed to add recipient', { error: (error as Error).message, locationId: req.params.id });
    res.status(500).json({ error: 'Failed to add recipient' });
  }
});

app.put('/api/locations/:id/recipients/:recipientId', authenticate, requireRole('admin'), async (req: AuthRequest, res) => {
  try {
    const { email, phone, active, notify_email, notify_sms, notify_whatsapp } = req.body;
    const existing = await getLocationRecipientById(req.params.recipientId);
    const updated = await updateLocationRecipient(req.params.recipientId, { email, phone, active, notify_email, notify_sms, notify_whatsapp });
    if (!updated) return res.status(404).json({ error: 'Recipient not found' });
    logger.info('Recipient updated', { recipientId: req.params.recipientId, by: req.user?.id });
    const effectivePhone = phone || existing?.phone;
    if (notify_whatsapp && !existing?.notify_whatsapp && effectivePhone) {
      sendWhatsAppOptInSms(effectivePhone).catch(() => {});
    }
    res.json(updated);
  } catch (error) {
    logger.error('Failed to update recipient', { error: (error as Error).message });
    res.status(500).json({ error: 'Failed to update recipient' });
  }
});

app.delete('/api/locations/:id/recipients/:recipientId', authenticate, requireRole('admin'), async (req: AuthRequest, res) => {
  try {
    const success = await deleteLocationRecipient(req.params.recipientId);
    if (!success) return res.status(404).json({ error: 'Recipient not found' });
    logger.info('Recipient deleted', { recipientId: req.params.recipientId, by: req.user?.id });
    res.status(204).send();
  } catch (error) {
    logger.error('Failed to delete recipient', { error: (error as Error).message });
    res.status(500).json({ error: 'Failed to delete recipient' });
  }
});

// -- Status --
app.get('/api/status', authenticate, requireRole('viewer'), async (_req: AuthRequest, res) => {
  try {
    const locations = await getAllLocations(_req.user!.org_id);
    const stateOrder: Record<string, number> = { STOP: 1, HOLD: 2, DEGRADED: 3, PREPARE: 4, ALL_CLEAR: 5 };
    
    const statuses = await Promise.all(
      locations.filter(l => l.enabled).map(async (loc) => {
        const rs = await getLatestRiskState(loc.id);
        
        const { lng, lat } = parseCentroid(loc.centroid);
        
        return {
          id: loc.id, 
          name: loc.name, 
          site_type: loc.site_type,
          lng, 
          lat,
          stop_radius_km: loc.stop_radius_km, 
          prepare_radius_km: loc.prepare_radius_km,
          state: rs?.state || null, 
          reason: rs?.reason || null,
          evaluated_at: rs?.evaluated_at || null,
          flashes_in_stop_radius: rs?.flashes_in_stop_radius ?? null,
          flashes_in_prepare_radius: rs?.flashes_in_prepare_radius ?? null,
          nearest_flash_km: rs?.nearest_flash_km ?? null,
          data_age_sec: rs?.data_age_sec ?? null,
          is_degraded: rs?.is_degraded ?? null,
        };
      })
    );
    
    statuses.sort((a, b) => 
      (stateOrder[a.state || 'ALL_CLEAR'] || 5) - (stateOrder[b.state || 'ALL_CLEAR'] || 5) || 
      a.name.localeCompare(b.name)
    );
    
    res.json(statuses);
  } catch (error) {
    logger.error('Failed to get status', { error: (error as Error).message });
    res.status(500).json({ error: 'Failed to get status' });
  }
});

app.get('/api/status/:locationId', authenticate, requireRole('viewer'), async (req, res) => {
  try {
    const { locationId } = req.params;
    const location = await getLocationById(locationId);
    
    if (!location) {
      return res.status(404).json({ error: 'Location not found' });
    }

    const [currentState, recentStates, nearbyFlashes] = await Promise.all([
      getLatestRiskState(locationId),
      getRecentRiskStates(locationId),
      getRecentFlashes(undefined, 30).then(flashes => {
        // Extract coordinates and filter by distance
        const centroidMatch = location.centroid.match(/POINT\(([-\d.]+) ([-\d.]+)\)/);
        const lng = centroidMatch ? parseFloat(centroidMatch[1]) : 0;
        const lat = centroidMatch ? parseFloat(centroidMatch[2]) : 0;
        
        return flashes
          .map(f => ({
            ...f,
            distance_km: calculateDistance(lat, lng, f.latitude, f.longitude)
          }))
          .filter(f => f.distance_km <= (location.prepare_radius_km || 20))
          .sort((a, b) => new Date(b.flash_time_utc).getTime() - new Date(a.flash_time_utc).getTime());
      })
    ]);

    res.json({ location, currentState, recentStates, nearbyFlashes });
  } catch (error) {
    logger.error('Failed to get location status', { 
      error: (error as Error).message,
      locationId: req.params.locationId 
    });
    res.status(500).json({ error: 'Failed to get location status' });
  }
});

// -- Flashes --
app.get('/api/flashes', authenticate, requireRole('viewer'), async (req, res) => {
  try {
    const { west, south, east, north, minutes } = req.query;
    const bbox = west && south && east && north
      ? { west: +west, south: +south, east: +east, north: +north }
      : undefined;
    const flashes = await getRecentFlashes(bbox, parseInt(minutes as string) || 30);
    res.json(flashes);
  } catch (error) {
    logger.error('Failed to get flashes', { error: (error as Error).message });
    res.status(500).json({ error: 'Failed to get flashes' });
  }
});

// -- Alerts --
app.get('/api/alerts', authenticate, requireRole('viewer'), async (req, res) => {
  try {
    const { location_id, limit, offset } = req.query;
    const lim = parseInt(limit as string) || 100;
    const off = parseInt(offset as string) || 0;

    const alerts = await getAlerts({
      location_id: location_id as string,
      limit: lim,
      offset: off,
    });

    // Enrich with location name and risk state (via JOIN)
    const { query: dbQuery } = await import('./db');
    const result = await dbQuery(
      `SELECT
         a.*,
         l.name AS location_name,
         rs.state,
         rs.reason AS state_reason
       FROM alerts a
       LEFT JOIN locations l ON l.id = a.location_id
       LEFT JOIN risk_states rs ON rs.id = a.state_id
       ${location_id ? 'WHERE a.location_id = $3' : ''}
       ORDER BY a.sent_at DESC NULLS LAST
       LIMIT $1 OFFSET $2`,
      location_id ? [lim, off, location_id] : [lim, off]
    );

    res.json(result.rows);
  } catch (error) {
    logger.error('Failed to get alerts', { error: (error as Error).message });
    res.status(500).json({ error: 'Failed to get alerts' });
  }
});

app.post('/api/ack/:alertId', authenticate, requireRole('operator'), async (req: AuthRequest, res) => {
  try {
    const { alertId } = req.params;
    const success = await acknowledgeAlert(alertId, req.user!.email);
    
    if (!success) {
      return res.status(404).json({ error: 'Alert not found or already acknowledged' });
    }
    
    logger.info('Alert acknowledged', {
      alertId,
      acknowledgedBy: req.user!.email
    });
    
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to acknowledge alert', { 
      error: (error as Error).message,
      alertId: req.params.alertId,
      acknowledgedBy: req.user?.email
    });
    res.status(500).json({ error: 'Failed to acknowledge alert' });
  }
});

// -- Replay --
app.get('/api/replay/:locationId', authenticate, requireRole('viewer'), async (req, res) => {
  try {
    const { locationId } = req.params;
    const lookback = parseInt(req.query.hours as string) || 24;

    const loc = await getLocationById(locationId);
    if (!loc) return res.status(404).json({ error: 'Location not found' });

    const { lng, lat } = parseCentroid(loc.centroid);

    // Risk states for this location in the lookback window
    const { query: dbQuery } = await import('./db');
    const statesRes = await dbQuery(
      `SELECT * FROM risk_states
       WHERE location_id = $1
         AND evaluated_at >= NOW() - ($2 || ' hours')::interval
       ORDER BY evaluated_at ASC`,
      [locationId, lookback.toString()]
    );

    // Flashes near this location in the lookback window
    const centroidWkt = `POINT(${lng} ${lat})`;
    const flashesRes = await dbQuery(
      `SELECT flash_id, flash_time_utc, latitude, longitude, radiance,
              duration_ms, filter_confidence,
              ST_Distance(geom::geography, ST_GeomFromText($1, 4326)::geography) / 1000.0 AS distance_km
       FROM flash_events
       WHERE flash_time_utc >= NOW() - ($2 || ' hours')::interval
         AND ST_DWithin(geom::geography, ST_GeomFromText($1, 4326)::geography, $3)
       ORDER BY flash_time_utc ASC`,
      [centroidWkt, lookback.toString(), loc.prepare_radius_km * 1000]
    );

    res.json({
      location: {
        id: loc.id, name: loc.name, lat, lng,
        stop_radius_km: loc.stop_radius_km,
        prepare_radius_km: loc.prepare_radius_km,
        stop_window_min: loc.stop_window_min,
        prepare_window_min: loc.prepare_window_min,
      },
      states: statesRes.rows,
      flashes: flashesRes.rows,
    });
  } catch (error) {
    logger.error('Failed to get replay data', {
      error: (error as Error).message,
      locationId: req.params.locationId
    });
    res.status(500).json({ error: 'Failed to get replay data' });
  }
});

// ============================================================
// Serve React frontend in production (static files from client build)
// ============================================================
const clientDistPath = path.resolve(__dirname, '..', 'client', 'dist');
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(clientDistPath));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDistPath, 'index.html'));
  });
}

// ============================================================
// Graceful shutdown
// ============================================================

const gracefulShutdown = (signal: string) => {
  logger.info(`Received ${signal}, starting graceful shutdown`);
  
  server.close(() => {
    logger.info('HTTP server closed');
    
    // Close WebSocket server
    wsManager.shutdown();
    
    // Stop risk engine
    const { stopRiskEngine } = require('./riskEngine');
    stopRiskEngine();
    
    // Close database connections
    const { pool } = require('./db');
    pool.end(() => {
      logger.info('Database pool closed');
      process.exit(0);
    });
  });
  
  // Force shutdown after 30 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ============================================================
// Start server + risk engine
// ============================================================

// Run DB migrations before starting
runMigrations()
  .then(() => server.listen(PORT, async () => {
  const modeLabel = liveMode ? 'LIVE EUMETSAT' : 'IN-MEMORY MOCK';

  logger.info(`⚡ FlashAware API running on http://localhost:${PORT}`);
  logger.info(`   Health check: http://localhost:${PORT}/api/health`);
  logger.info(`   Mode: ${modeLabel}`);

  // Start risk engine
  const riskIntervalSec = parseInt(process.env.RISK_ENGINE_INTERVAL_SEC || '60');
  startRiskEngine(riskIntervalSec);

  if (liveMode) {
    // Attempt live EUMETSAT ingestion
    const ingestionIntervalSec = parseInt(process.env.INGESTION_INTERVAL_SEC || '120');
    const started = await startLiveIngestion(ingestionIntervalSec);
    if (!started) {
      logger.warn('Live ingestion failed, falling back to simulation');
      // Start flash simulation as fallback
      const { startFlashSimulation } = require('./eumetsatService');
      startFlashSimulation(15000);
    }
  } else {
    logger.warn('EUMETSAT credentials not set — using simulated flash data');
    logger.info('Set EUMETSAT_CONSUMER_KEY and EUMETSAT_CONSUMER_SECRET in .env for live data');
    
    // Start flash simulation
    const { startFlashSimulation } = require('./eumetsatService');
    startFlashSimulation(15000);
  }

  // Check for unacknowledged alerts every 2 minutes
  setInterval(async () => {
    await checkEscalations();
  }, 120_000);

  // Data retention: purge old rows every 6 hours
  const retentionDays = parseInt(process.env.DATA_RETENTION_DAYS || '30');
  const runRetention = async () => {
    try {
      const { query } = await import('./db');
      const r1 = await query(
        `DELETE FROM flash_events WHERE flash_time_utc < NOW() - ($1 || ' days')::interval`,
        [retentionDays.toString()]
      );
      const r2 = await query(
        `DELETE FROM risk_states WHERE evaluated_at < NOW() - ($1 || ' days')::interval`,
        [retentionDays.toString()]
      );
      const r3 = await query(
        `DELETE FROM alerts WHERE sent_at < NOW() - ($1 || ' days')::interval`,
        [retentionDays.toString()]
      );
      logger.info(`Data retention: removed ${r1.rowCount} flash_events, ${r2.rowCount} risk_states, ${r3.rowCount} alerts older than ${retentionDays}d`);
    } catch (err) {
      logger.warn({ err }, 'Data retention job failed (non-fatal)');
    }
  };
  runRetention(); // run once on startup to immediately reclaim space
  setInterval(runRetention, 6 * 60 * 60 * 1000); // then every 6 hours
}))
  .catch((err: Error) => {
    logger.error({ err }, 'Startup migration failed — exiting');
    process.exit(1);
  });

export default app;

// Helper function for distance calculation
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

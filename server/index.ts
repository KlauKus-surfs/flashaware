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
  getLocationsWithLatestState,
  getRecentFlashes,
  getLatestRiskState,
  getLatestIngestionTime,
  createLocation,
  deleteLocation,
  updateLocation,
  getLocationById,
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
  getOrgSettings,
  setOrgSetting,
} from './queries';
import { hasCredentials, startLiveIngestion } from './eumetsatService';
import { logger } from './logger';
import { wsManager } from './websocket';
import userRoutes from './userRoutes';
import orgRoutes from './orgRoutes';
import { runMigrations } from './migrate';
import { startLeaderElection, releaseLeaderLock } from './leader';
import { logAudit, getAuditRows } from './audit';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// Parse WKT "POINT(lng lat)" into { lng, lat } numbers
function parseCentroid(wkt: string | null | undefined): { lng: number; lat: number } {
  if (!wkt) return { lng: 0, lat: 0 };
  const m = wkt.match(/POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/i);
  if (!m) return { lng: 0, lat: 0 };
  return { lng: parseFloat(m[1]), lat: parseFloat(m[2]) };
}

// Fetch a location only if the caller is allowed to see it. Super-admins can
// reach any org; everyone else is locked to their own. Returns null on miss
// (callers should respond 404 so we never leak existence to other tenants).
async function getLocationForUser(id: string, user: { role: string; org_id: string }) {
  const loc = await getLocationById(id);
  if (!loc) return null;
  if (user.role === 'super_admin') return loc;
  if (loc.org_id !== user.org_id) return null;
  return loc;
}

import { isValidEmail, isValidE164, isFiniteNum, UUID_RE } from './validators';

/**
 * Resolve the org scope for a list endpoint:
 *   - non-super: always their own org
 *   - super_admin with no ?org_id=    : undefined (cross-org view)
 *   - super_admin with ?org_id=<uuid> : that org (single-org view)
 *
 * Returns { ok: false, status, error } if a non-super tried to use ?org_id=,
 * or the value is malformed. Callers should res.status(...).json(...) and bail.
 */
function resolveOrgScope(req: AuthRequest): { ok: true; orgId: string | undefined } | { ok: false; status: number; error: string } {
  const queryOrg = typeof req.query.org_id === 'string' ? req.query.org_id : undefined;
  if (queryOrg !== undefined) {
    if (req.user!.role !== 'super_admin') {
      return { ok: false, status: 403, error: 'org_id is only allowed for super_admin' };
    }
    if (!UUID_RE.test(queryOrg)) {
      return { ok: false, status: 400, error: 'org_id must be a valid UUID' };
    }
    return { ok: true, orgId: queryOrg };
  }
  if (req.user!.role === 'super_admin') return { ok: true, orgId: undefined };
  return { ok: true, orgId: req.user!.org_id };
}

const app = express();
const server = createServer(app);
const PORT = parseInt(process.env.SERVER_PORT || '4000');

// Background job handles, cleared on shutdown so the process can exit cleanly.
let escalationInterval: ReturnType<typeof setInterval> | null = null;
let retentionInterval: ReturnType<typeof setInterval> | null = null;

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
    } catch (err) {
      // Enrichment is best-effort: the DB ping above is the real health
      // signal. We still log so a degraded-but-up DB is visible in alerts.
      logger.warn('Health check enrichment failed', { error: (err as Error).message });
    }

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

  await logAudit({
    req,
    actor: { id: result.user.id, email: result.user.email, role: result.user.role },
    action: 'user.login',
    target_type: 'user',
    target_id: result.user.id,
    target_org_id: result.user.org_id,
  });

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
    const scope = resolveOrgScope(_req);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    const rows = await getLocationsWithLatestState(scope.orgId);
    const result = rows.map(loc => {
      const { lng, lat } = parseCentroid(loc.centroid);
      return { ...loc, lng, lat };
    });
    res.json(result);
  } catch (error) {
    logger.error('Failed to get locations', { error: (error as Error).message });
    res.status(500).json({ error: 'Failed to get locations' });
  }
});

app.post('/api/locations', authenticate, requireRole('admin'), async (req: AuthRequest, res) => {
  try {
    const { name, site_type, centroid, timezone, thresholds, org_id: bodyOrgId } = req.body;

    if (typeof name !== 'string' || name.trim().length === 0 || name.length > 200) {
      return res.status(400).json({ error: 'Name is required (1-200 chars)' });
    }
    if (!centroid || !isFiniteNum(centroid.lat) || !isFiniteNum(centroid.lng)) {
      return res.status(400).json({ error: 'centroid.lat and centroid.lng must be finite numbers' });
    }
    if (centroid.lat < -90 || centroid.lat > 90 || centroid.lng < -180 || centroid.lng > 180) {
      return res.status(400).json({ error: 'centroid out of range (lat -90..90, lng -180..180)' });
    }

    // super_admin can create locations into any org (e.g. onboarding a customer
    // before their admins are set up). Everyone else creates into their own org;
    // a non-super passing org_id gets a 403 — never silently re-routed.
    let targetOrgId = req.user!.org_id;
    if (bodyOrgId !== undefined && bodyOrgId !== null && bodyOrgId !== '') {
      if (req.user!.role !== 'super_admin') {
        return res.status(403).json({ error: 'org_id is only allowed for super_admin' });
      }
      if (typeof bodyOrgId !== 'string' || !UUID_RE.test(bodyOrgId)) {
        return res.status(400).json({ error: 'org_id must be a valid UUID' });
      }
      const { getOne } = await import('./db');
      const org = await getOne<{ id: string }>('SELECT id FROM organisations WHERE id = $1', [bodyOrgId]);
      if (!org) return res.status(404).json({ error: 'Organisation not found' });
      targetOrgId = bodyOrgId;
    }

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
      org_id: targetOrgId,
      timezone: timezone || 'Africa/Johannesburg',
      stop_radius_km: thresholds?.stop_radius_km ?? 10,
      prepare_radius_km: thresholds?.prepare_radius_km ?? 20,
      stop_flash_threshold: thresholds?.stop_flash_threshold ?? 1,
      stop_window_min: thresholds?.stop_window_min ?? 15,
      prepare_flash_threshold: thresholds?.prepare_flash_threshold ?? 1,
      prepare_window_min: thresholds?.prepare_window_min ?? 15,
      allclear_wait_min: thresholds?.allclear_wait_min ?? 30,
      persistence_alert_min: thresholds?.persistence_alert_min ?? 10,
      alert_on_change_only: thresholds?.alert_on_change_only ?? false,
    });
    
    logger.info('Location created', {
      locationId: newLoc.id,
      locationName: newLoc.name,
      createdBy: req.user?.id
    });
    await logAudit({
      req,
      action: 'location.create',
      target_type: 'location',
      target_id: newLoc.id,
      target_org_id: targetOrgId,
      after: { name: newLoc.name, site_type: newLoc.site_type, org_id: targetOrgId },
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

    const existingLoc = await getLocationForUser(id, req.user!);
    if (!existingLoc) {
      return res.status(404).json({ error: 'Location not found' });
    }

    if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0 || name.length > 200)) {
      return res.status(400).json({ error: 'Name must be 1-200 chars' });
    }
    if (centroid !== undefined && centroid !== null) {
      if (!isFiniteNum(centroid.lat) || !isFiniteNum(centroid.lng)) {
        return res.status(400).json({ error: 'centroid.lat and centroid.lng must be finite numbers' });
      }
      if (centroid.lat < -90 || centroid.lat > 90 || centroid.lng < -180 || centroid.lng > 180) {
        return res.status(400).json({ error: 'centroid out of range (lat -90..90, lng -180..180)' });
      }
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
    if (thresholds?.alert_on_change_only !== undefined) updates.alert_on_change_only = thresholds.alert_on_change_only;
    if (enabled !== undefined) updates.enabled = enabled;
    
    const updatedLoc = await updateLocation(id, updates);

    logger.info('Location updated', {
      locationId: id,
      updatedBy: req.user?.id,
      fields: Object.keys(updates)
    });
    await logAudit({
      req,
      action: 'location.update',
      target_type: 'location',
      target_id: id,
      target_org_id: existingLoc.org_id,
      before: { name: existingLoc.name, site_type: existingLoc.site_type, enabled: existingLoc.enabled },
      after: updates,
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
    const existing = await getLocationForUser(id, req.user!);
    if (!existing) return res.status(404).json({ error: 'Location not found' });
    const deleted = await deleteLocation(id);
    if (!deleted) return res.status(500).json({ error: 'Delete failed' });
    logger.info('Location deleted', { locationId: id, deletedBy: req.user?.id });
    await logAudit({
      req,
      action: 'location.delete',
      target_type: 'location',
      target_id: id,
      target_org_id: existing.org_id,
      before: { name: existing.name, site_type: existing.site_type },
    });
    res.status(204).send();
  } catch (error) {
    logger.error('Failed to delete location', { error: (error as Error).message, locationId: req.params.id });
    res.status(500).json({ error: 'Failed to delete location' });
  }
});

// -- Settings --
// /api/settings:           per-org overrides (caller's own org, or super_admin's scoped org).
//                          GETting also returns the merged effective values.
// /api/platform-settings:  platform-wide defaults — super_admin only.
const SETTINGS_ALLOWED_KEYS = ['email_enabled', 'sms_enabled', 'escalation_enabled', 'escalation_delay_min', 'alert_from_address'];

function settingsScopeOrg(req: AuthRequest): string {
  // super_admin can scope writes via the org-picker (?org_id=…). Without it
  // they target their own org (FlashAware default).
  const queryOrg = typeof req.query.org_id === 'string' ? req.query.org_id : undefined;
  if (queryOrg && req.user!.role === 'super_admin' && UUID_RE.test(queryOrg)) return queryOrg;
  return req.user!.org_id;
}

app.get('/api/settings', authenticate, requireRole('admin'), async (req: AuthRequest, res) => {
  try {
    const orgId = settingsScopeOrg(req);
    const merged = await getOrgSettings(orgId); // platform defaults + org overrides
    res.json({ ...merged, _scope_org_id: orgId });
  } catch (error) {
    logger.error('Failed to get settings', { error: (error as Error).message });
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

app.post('/api/settings', authenticate, requireRole('admin'), async (req: AuthRequest, res) => {
  try {
    const orgId = settingsScopeOrg(req);
    const updates = Object.entries(req.body as Record<string, string>)
      .filter(([k]) => SETTINGS_ALLOWED_KEYS.includes(k));
    const before = await getOrgSettings(orgId);
    await Promise.all(updates.map(([k, v]) => setOrgSetting(orgId, k, String(v))));
    logger.info('Org settings updated', { orgId, keys: updates.map(([k]) => k), by: req.user?.id });
    await logAudit({
      req,
      action: 'settings.update',
      target_type: 'settings',
      target_id: null,
      target_org_id: orgId,
      before: Object.fromEntries(updates.map(([k]) => [k, before[k]])),
      after: Object.fromEntries(updates),
    });
    res.json({ ok: true });
  } catch (error) {
    logger.error('Failed to save settings', { error: (error as Error).message });
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

app.get('/api/platform-settings', authenticate, requireRole('super_admin'), async (_req: AuthRequest, res) => {
  try {
    const settings = await getAppSettings();
    res.json(settings);
  } catch (error) {
    logger.error('Failed to get platform settings', { error: (error as Error).message });
    res.status(500).json({ error: 'Failed to get platform settings' });
  }
});

app.post('/api/platform-settings', authenticate, requireRole('super_admin'), async (req: AuthRequest, res) => {
  try {
    const updates = Object.entries(req.body as Record<string, string>)
      .filter(([k]) => SETTINGS_ALLOWED_KEYS.includes(k));
    const before = await getAppSettings();
    await Promise.all(updates.map(([k, v]) => setAppSetting(k, String(v))));
    logger.info('Platform settings updated', { keys: updates.map(([k]) => k), by: req.user?.id });
    await logAudit({
      req,
      action: 'platform_settings.update',
      target_type: 'platform_settings',
      target_id: null,
      target_org_id: null,
      before: Object.fromEntries(updates.map(([k]) => [k, before[k]])),
      after: Object.fromEntries(updates),
    });
    res.json({ ok: true });
  } catch (error) {
    logger.error('Failed to save platform settings', { error: (error as Error).message });
    res.status(500).json({ error: 'Failed to save platform settings' });
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
    await logAudit({
      req,
      action: 'alert.test_email',
      target_type: 'alert',
      target_id: null,
      target_org_id: req.user!.org_id,
      after: { to },
    });
    res.json({ ok: true, message: `Test email sent to ${to}` });
  } catch (error) {
    logger.error('Test email failed', { error: (error as Error).message, to });
    res.status(500).json({ error: (error as Error).message });
  }
});

// -- Location Recipients --
app.get('/api/locations/:id/recipients', authenticate, requireRole('viewer'), async (req: AuthRequest, res) => {
  try {
    const loc = await getLocationForUser(req.params.id, req.user!);
    if (!loc) return res.status(404).json({ error: 'Location not found' });
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
    if (!email || typeof email !== 'string' || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Valid email is required' });
    }
    if (phone !== undefined && phone !== null && phone !== '' && !isValidE164(phone)) {
      return res.status(400).json({ error: 'Phone must be E.164 format (e.g. +27821234567)' });
    }
    const locationId = req.params.id;
    const loc = await getLocationForUser(locationId, req.user!);
    if (!loc) return res.status(404).json({ error: 'Location not found' });

    const { notify_email, notify_sms, notify_whatsapp } = req.body;
    const id = await addLocationRecipient({ location_id: locationId, email: email.trim().toLowerCase(), phone: phone || null, active: true, notify_email: notify_email !== false, notify_sms: !!notify_sms, notify_whatsapp: !!notify_whatsapp });
    logger.info('Recipient added', { locationId, email, by: req.user?.id });
    await logAudit({
      req,
      action: 'recipient.create',
      target_type: 'recipient',
      target_id: id,
      target_org_id: loc.org_id,
      after: { location_id: locationId, email: email.trim().toLowerCase(), phone: phone || null,
               notify_email: notify_email !== false, notify_sms: !!notify_sms, notify_whatsapp: !!notify_whatsapp },
    });
    res.status(201).json({ id });
  } catch (error) {
    logger.error('Failed to add recipient', { error: (error as Error).message, locationId: req.params.id });
    res.status(500).json({ error: 'Failed to add recipient' });
  }
});

app.put('/api/locations/:id/recipients/:recipientId', authenticate, requireRole('admin'), async (req: AuthRequest, res) => {
  try {
    const loc = await getLocationForUser(req.params.id, req.user!);
    if (!loc) return res.status(404).json({ error: 'Location not found' });
    const existing = await getLocationRecipientById(req.params.recipientId);
    if (!existing || existing.location_id !== req.params.id) {
      return res.status(404).json({ error: 'Recipient not found' });
    }
    const { email, phone, active, notify_email, notify_sms, notify_whatsapp } = req.body;
    if (email !== undefined && !isValidEmail(email)) {
      return res.status(400).json({ error: 'Valid email is required' });
    }
    if (phone !== undefined && phone !== null && phone !== '' && !isValidE164(phone)) {
      return res.status(400).json({ error: 'Phone must be E.164 format (e.g. +27821234567)' });
    }
    // If phone changed, mark phone as unverified again so SMS/WhatsApp gates re-check
    const phoneChanged = phone !== undefined && phone !== existing.phone;
    const updated = await updateLocationRecipient(req.params.recipientId, {
      email, phone, active, notify_email, notify_sms, notify_whatsapp,
      ...(phoneChanged ? { phone_verified_at: null } : {}),
    });
    if (!updated) return res.status(404).json({ error: 'Recipient not found' });
    logger.info('Recipient updated', { recipientId: req.params.recipientId, by: req.user?.id, phoneChanged });
    await logAudit({
      req,
      action: 'recipient.update',
      target_type: 'recipient',
      target_id: req.params.recipientId,
      target_org_id: loc.org_id,
      before: { email: existing.email, phone: existing.phone, active: existing.active,
                notify_email: existing.notify_email, notify_sms: existing.notify_sms, notify_whatsapp: existing.notify_whatsapp,
                phone_verified_at: existing.phone_verified_at },
      after: { email, phone, active, notify_email, notify_sms, notify_whatsapp, phone_changed: phoneChanged },
    });
    res.json(updated);
  } catch (error) {
    logger.error('Failed to update recipient', { error: (error as Error).message });
    res.status(500).json({ error: 'Failed to update recipient' });
  }
});

app.delete('/api/locations/:id/recipients/:recipientId', authenticate, requireRole('admin'), async (req: AuthRequest, res) => {
  try {
    const loc = await getLocationForUser(req.params.id, req.user!);
    if (!loc) return res.status(404).json({ error: 'Location not found' });
    const existing = await getLocationRecipientById(req.params.recipientId);
    if (!existing || existing.location_id !== req.params.id) {
      return res.status(404).json({ error: 'Recipient not found' });
    }
    const success = await deleteLocationRecipient(req.params.recipientId);
    if (!success) return res.status(404).json({ error: 'Recipient not found' });
    logger.info('Recipient deleted', { recipientId: req.params.recipientId, by: req.user?.id });
    await logAudit({
      req,
      action: 'recipient.delete',
      target_type: 'recipient',
      target_id: req.params.recipientId,
      target_org_id: loc.org_id,
      before: { email: existing.email, phone: existing.phone },
    });
    res.status(204).send();
  } catch (error) {
    logger.error('Failed to delete recipient', { error: (error as Error).message });
    res.status(500).json({ error: 'Failed to delete recipient' });
  }
});

// -- Phone OTP verification for SMS/WhatsApp recipients --
async function loadRecipientForOtp(req: AuthRequest, res: any) {
  const loc = await getLocationForUser(req.params.id, req.user!);
  if (!loc) { res.status(404).json({ error: 'Location not found' }); return null; }
  const recipient = await getLocationRecipientById(req.params.recipientId);
  if (!recipient || recipient.location_id !== req.params.id) {
    res.status(404).json({ error: 'Recipient not found' }); return null;
  }
  if (!recipient.phone) {
    res.status(400).json({ error: 'Recipient has no phone number' }); return null;
  }
  if (!isValidE164(recipient.phone)) {
    res.status(400).json({ error: 'Recipient phone is not in E.164 format' }); return null;
  }
  return recipient;
}

app.post('/api/locations/:id/recipients/:recipientId/send-otp', authenticate, requireRole('admin'), async (req: AuthRequest, res) => {
  try {
    const recipient = await loadRecipientForOtp(req, res);
    if (!recipient) return;
    const { sendPhoneOtp } = await import('./otpService');
    const result = await sendPhoneOtp(recipient.id, recipient.phone!);
    if (!result.ok) {
      const status = result.reason === 'rate_limited' ? 429
        : result.reason === 'twilio_disabled' ? 503
        : 500;
      return res.status(status).json({
        error: result.error || result.reason || 'Failed to send code',
        reason: result.reason,
        retry_at: result.retry_at,
      });
    }
    // Look up org_id via the location for audit context.
    const loc = await getLocationForUser(req.params.id, req.user!);
    await logAudit({
      req,
      action: 'recipient.otp_send',
      target_type: 'recipient',
      target_id: recipient.id,
      target_org_id: loc?.org_id ?? null,
      after: { phone: recipient.phone },
    });
    res.json({ ok: true });
  } catch (error) {
    logger.error('Failed to send OTP', { error: (error as Error).message, recipientId: req.params.recipientId });
    res.status(500).json({ error: 'Failed to send verification code' });
  }
});

app.post('/api/locations/:id/recipients/:recipientId/verify-otp', authenticate, requireRole('admin'), async (req: AuthRequest, res) => {
  try {
    const recipient = await loadRecipientForOtp(req, res);
    if (!recipient) return;
    const code = String(req.body?.code || '').trim();
    if (!/^\d{4,8}$/.test(code)) {
      return res.status(400).json({ error: 'Invalid code format' });
    }
    const { verifyPhoneOtp } = await import('./otpService');
    const result = await verifyPhoneOtp(recipient.id, recipient.phone!, code);
    if (!result.ok) {
      const status = result.reason === 'too_many_attempts' ? 429 : 400;
      return res.status(status).json({
        error: result.reason || 'verification_failed',
        reason: result.reason,
        attempts_remaining: result.attempts_remaining,
      });
    }
    const loc = await getLocationForUser(req.params.id, req.user!);
    await logAudit({
      req,
      action: 'recipient.phone_verify',
      target_type: 'recipient',
      target_id: recipient.id,
      target_org_id: loc?.org_id ?? null,
      after: { phone: recipient.phone, verified_at: new Date().toISOString() },
    });
    res.json({ ok: true, verified_at: new Date().toISOString() });
  } catch (error) {
    logger.error('Failed to verify OTP', { error: (error as Error).message, recipientId: req.params.recipientId });
    res.status(500).json({ error: 'Failed to verify code' });
  }
});

// -- Platform overview (super_admin only) — high-level health for the operator --
app.get('/api/platform/overview', authenticate, requireRole('super_admin'), async (_req: AuthRequest, res) => {
  try {
    const { query: dbQuery } = await import('./db');
    const { amLeader } = await import('./leader');

    // Single round-trip with sub-selects to avoid sequential round-trips.
    const r = await dbQuery(`
      SELECT
        (SELECT COUNT(*)::int FROM organisations WHERE deleted_at IS NULL)                                    AS active_org_count,
        (SELECT COUNT(*)::int FROM organisations WHERE deleted_at IS NOT NULL)                                AS soft_deleted_org_count,
        (SELECT COUNT(*)::int FROM users u INNER JOIN organisations o ON o.id = u.org_id AND o.deleted_at IS NULL) AS active_user_count,
        (SELECT COUNT(*)::int FROM locations l INNER JOIN organisations o ON o.id = l.org_id AND o.deleted_at IS NULL)                          AS total_location_count,
        (SELECT COUNT(*)::int FROM locations l INNER JOIN organisations o ON o.id = l.org_id AND o.deleted_at IS NULL WHERE l.enabled = true)   AS active_location_count,
        (SELECT COUNT(*)::int FROM alerts WHERE sent_at >= NOW() - interval '24 hours')                       AS alerts_last_24h,
        (SELECT COUNT(*)::int FROM alerts WHERE sent_at >= NOW() - interval '24 hours' AND acknowledged_at IS NULL) AS unacked_last_24h,
        (SELECT COUNT(*)::int FROM alerts WHERE sent_at >= NOW() - interval '24 hours' AND escalated = true)  AS escalated_last_24h,
        (SELECT MAX(product_time_end) FROM ingestion_log WHERE qc_status != 'ERROR')                          AS last_ingestion,
        (SELECT COUNT(*)::int FROM flash_events WHERE flash_time_utc >= NOW() - interval '1 hour')            AS flashes_last_hour
    `);
    const row = r.rows[0];

    // Per-org alert counts (top 10 by 24h alert volume).
    const perOrg = await dbQuery(`
      SELECT
        o.id, o.name, o.slug,
        COUNT(DISTINCT l.id) FILTER (WHERE l.enabled = true)::int     AS active_locations,
        COUNT(DISTINCT a.id) FILTER (WHERE a.sent_at >= NOW() - interval '24 hours')::int AS alerts_24h,
        COUNT(DISTINCT a.id) FILTER (WHERE a.sent_at >= NOW() - interval '24 hours' AND a.escalated = true)::int AS escalated_24h
      FROM organisations o
      LEFT JOIN locations l ON l.org_id = o.id
      LEFT JOIN alerts a    ON a.location_id = l.id
      WHERE o.deleted_at IS NULL
      GROUP BY o.id
      ORDER BY alerts_24h DESC, o.name
      LIMIT 10
    `);

    const attention = await dbQuery(`
      SELECT
        o.id, o.name, o.slug,
        COUNT(DISTINCT a.id) FILTER (WHERE a.acknowledged_at IS NULL AND a.sent_at >= NOW() - interval '24 hours')::int AS unacked_24h,
        COUNT(DISTINCT a.id) FILTER (WHERE a.escalated = true AND a.sent_at >= NOW() - interval '24 hours')::int        AS escalated_24h
      FROM organisations o
      LEFT JOIN locations l ON l.org_id = o.id
      LEFT JOIN alerts a    ON a.location_id = l.id
      WHERE o.deleted_at IS NULL
      GROUP BY o.id
      HAVING
        COUNT(DISTINCT a.id) FILTER (WHERE a.acknowledged_at IS NULL AND a.sent_at >= NOW() - interval '24 hours') >= 5
        OR COUNT(DISTINCT a.id) FILTER (WHERE a.escalated = true AND a.sent_at >= NOW() - interval '24 hours') > 0
      ORDER BY unacked_24h DESC, escalated_24h DESC
    `);

    const lastIngestion = row.last_ingestion ? new Date(row.last_ingestion) : null;
    const dataAgeMin = lastIngestion ? Math.floor((Date.now() - lastIngestion.getTime()) / 60_000) : null;

    res.json({
      orgs: {
        active: row.active_org_count,
        soft_deleted: row.soft_deleted_org_count,
      },
      users: { active: row.active_user_count },
      locations: {
        total: row.total_location_count,
        active: row.active_location_count,
      },
      alerts_24h: {
        total: row.alerts_last_24h,
        unacked: row.unacked_last_24h,
        escalated: row.escalated_last_24h,
      },
      ingestion: {
        last_ingestion: row.last_ingestion,
        data_age_minutes: dataAgeMin,
        feed_healthy: dataAgeMin !== null && dataAgeMin < 25,
        flashes_last_hour: row.flashes_last_hour,
      },
      leader: {
        am_i_leader: amLeader(),
        machine_id: process.env.FLY_MACHINE_ID || null,
        region: process.env.FLY_REGION || null,
      },
      top_orgs_by_alerts: perOrg.rows,
      needs_attention: attention.rows,
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to build platform overview', { error: (error as Error).message });
    res.status(500).json({ error: 'Failed to build platform overview' });
  }
});

// -- Audit log (admin sees own org; super_admin sees all or filtered by ?org_id=) --
app.get('/api/audit', authenticate, requireRole('admin'), async (req: AuthRequest, res) => {
  try {
    const scope = resolveOrgScope(req);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });

    const rows = await getAuditRows({
      org_id: scope.orgId,
      action: typeof req.query.action === 'string' ? req.query.action : undefined,
      action_prefix: typeof req.query.action_prefix === 'string' ? req.query.action_prefix : undefined,
      target_type: typeof req.query.target_type === 'string' ? req.query.target_type : undefined,
      target_id: typeof req.query.target_id === 'string' ? req.query.target_id : undefined,
      actor_user_id: typeof req.query.actor_user_id === 'string' ? req.query.actor_user_id : undefined,
      actor_email: typeof req.query.actor_email === 'string' ? req.query.actor_email : undefined,
      since: typeof req.query.since === 'string' ? req.query.since : undefined,
      until: typeof req.query.until === 'string' ? req.query.until : undefined,
      limit: parseInt(req.query.limit as string) || 100,
      offset: parseInt(req.query.offset as string) || 0,
    });
    res.json(rows);
  } catch (error) {
    logger.error('Failed to read audit log', { error: (error as Error).message });
    res.status(500).json({ error: 'Failed to read audit log' });
  }
});

// -- Onboarding state -- drives the Dashboard SetupChecklist so a freshly-
// invited admin sees a path forward instead of an empty dashboard.
app.get('/api/onboarding/state', authenticate, requireRole('viewer'), async (req: AuthRequest, res) => {
  try {
    const scope = resolveOrgScope(req);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    // For super_admin with no scope set we can't compute "are we onboarded yet"
    // because there's no single org. Use their own org as the answer.
    const orgId = scope.orgId ?? req.user!.org_id;
    const { query } = await import('./db');
    const r = await query(
      `SELECT
         (SELECT COUNT(*)::int FROM locations WHERE org_id = $1)                                                 AS location_count,
         (SELECT COUNT(*)::int FROM location_recipients lr
            INNER JOIN locations l ON l.id = lr.location_id
            WHERE l.org_id = $1)                                                                                  AS recipient_count,
         (SELECT COUNT(*)::int FROM location_recipients lr
            INNER JOIN locations l ON l.id = lr.location_id
            WHERE l.org_id = $1 AND lr.phone_verified_at IS NOT NULL)                                             AS verified_recipient_count`,
      [orgId]
    );
    const row = r.rows[0];
    res.json({
      hasLocation: row.location_count > 0,
      hasRecipient: row.recipient_count > 0,
      hasVerifiedPhone: row.verified_recipient_count > 0,
    });
  } catch (error) {
    logger.error('Failed to get onboarding state', { error: (error as Error).message });
    res.status(500).json({ error: 'Failed to get onboarding state' });
  }
});

// -- Status --
app.get('/api/status', authenticate, requireRole('viewer'), async (_req: AuthRequest, res) => {
  try {
    const scope = resolveOrgScope(_req);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    const rows = await getLocationsWithLatestState(scope.orgId, { enabledOnly: true });
    const stateOrder: Record<string, number> = { STOP: 1, HOLD: 2, DEGRADED: 3, PREPARE: 4, ALL_CLEAR: 5 };

    const statuses = rows.map(loc => {
      const { lng, lat } = parseCentroid(loc.centroid);
      return {
        id: loc.id,
        name: loc.name,
        site_type: loc.site_type,
        lng,
        lat,
        stop_radius_km: loc.stop_radius_km,
        prepare_radius_km: loc.prepare_radius_km,
        state: loc.current_state,
        reason: loc.state_reason,
        evaluated_at: loc.state_evaluated_at,
        flashes_in_stop_radius: loc.flashes_in_stop_radius,
        flashes_in_prepare_radius: loc.flashes_in_prepare_radius,
        nearest_flash_km: loc.nearest_flash_km,
        data_age_sec: loc.data_age_sec,
        is_degraded: loc.is_degraded,
      };
    });

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

app.get('/api/status/:locationId', authenticate, requireRole('viewer'), async (req: AuthRequest, res) => {
  try {
    const { locationId } = req.params;
    const location = await getLocationForUser(locationId, req.user!);

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
    const { west, south, east, north, minutes, limit } = req.query;
    const bbox = west && south && east && north
      ? { west: +west, south: +south, east: +east, north: +north }
      : undefined;
    const minutesParam = Math.min(Math.max(parseInt(minutes as string) || 30, 1), 1440);
    const limitParam = parseInt(limit as string) || 10000;
    const flashes = await getRecentFlashes(bbox, minutesParam, limitParam);
    res.json(flashes);
  } catch (error) {
    logger.error('Failed to get flashes', { error: (error as Error).message });
    res.status(500).json({ error: 'Failed to get flashes' });
  }
});

// -- Alerts --
app.get('/api/alerts', authenticate, requireRole('viewer'), async (req: AuthRequest, res) => {
  try {
    const { location_id, limit, offset } = req.query;
    const lim = parseInt(limit as string) || 100;
    const off = parseInt(offset as string) || 0;

    // Enrich with location name + org name and risk state. super_admin sees
    // alerts across all orgs by default, or one org via ?org_id=. Everyone
    // else is locked to their own org and forbidden from passing ?org_id=.
    const scope = resolveOrgScope(req);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });

    const { query: dbQuery } = await import('./db');
    const conditions: string[] = [];
    const params: any[] = [lim, off];
    if (scope.orgId !== undefined) {
      conditions.push(`l.org_id = $${params.length + 1}`);
      params.push(scope.orgId);
    }
    if (location_id) {
      conditions.push(`a.location_id = $${params.length + 1}`);
      params.push(location_id);
    }
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await dbQuery(
      `SELECT
         a.*,
         l.name AS location_name,
         o.name AS org_name,
         o.slug AS org_slug,
         rs.state,
         rs.reason AS state_reason
       FROM alerts a
       INNER JOIN locations l ON l.id = a.location_id
       LEFT JOIN organisations o ON o.id = l.org_id
       LEFT JOIN risk_states rs ON rs.id = a.state_id
       ${whereClause}
       ORDER BY a.sent_at DESC NULLS LAST
       LIMIT $1 OFFSET $2`,
      params
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
    await logAudit({
      req,
      action: 'alert.ack',
      target_type: 'alert',
      target_id: alertId,
      target_org_id: req.user!.org_id,
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
app.get('/api/replay/:locationId', authenticate, requireRole('viewer'), async (req: AuthRequest, res) => {
  try {
    const { locationId } = req.params;
    const lookback = Math.min(Math.max(parseInt(req.query.hours as string) || 24, 1), 168);

    const loc = await getLocationForUser(locationId, req.user!);
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

  // Stop background jobs first so they can't fire mid-shutdown
  if (escalationInterval) { clearInterval(escalationInterval); escalationInterval = null; }
  if (retentionInterval) { clearInterval(retentionInterval); retentionInterval = null; }

  server.close(() => {
    logger.info('HTTP server closed');

    // Close WebSocket server
    wsManager.shutdown();

    // Stop risk engine
    const { stopRiskEngine } = require('./riskEngine');
    stopRiskEngine();

    // Stop ingestion poller (best effort — not fatal if not started)
    try {
      const { stopLiveIngestion } = require('./eumetsatService');
      if (typeof stopLiveIngestion === 'function') stopLiveIngestion();
    } catch (_) { /* ignore */ }

    // Release advisory lock if we held it
    releaseLeaderLock().catch(() => { /* ignore */ });

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

// Leader-only background work. Runs on whichever machine wins the advisory lock.
async function startLeaderJobs(): Promise<void> {
  const riskIntervalSec = parseInt(process.env.RISK_ENGINE_INTERVAL_SEC || '60');
  startRiskEngine(riskIntervalSec);

  if (liveMode) {
    const ingestionIntervalSec = parseInt(process.env.INGESTION_INTERVAL_SEC || '120');
    const started = await startLiveIngestion(ingestionIntervalSec);
    if (!started) {
      logger.warn('Live ingestion failed, falling back to simulation');
      const { startFlashSimulation } = require('./eumetsatService');
      startFlashSimulation(15000);
    }
  } else {
    logger.warn('EUMETSAT credentials not set — using simulated flash data');
    logger.info('Set EUMETSAT_CONSUMER_KEY and EUMETSAT_CONSUMER_SECRET in .env for live data');
    const { startFlashSimulation } = require('./eumetsatService');
    startFlashSimulation(15000);
  }

  // Check for unacknowledged alerts every 2 minutes
  escalationInterval = setInterval(async () => {
    await checkEscalations();
  }, 120_000);

  // Data retention: purge old rows every 6 hours
  const retentionDays = parseInt(process.env.DATA_RETENTION_DAYS || '30');
  const orgGraceDays = parseInt(process.env.ORG_HARD_DELETE_DAYS || '30');
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
      // Hard-delete soft-deleted orgs after the grace window. Cascades remove
      // their users, locations, alerts, etc.
      const r4 = await query(
        `DELETE FROM organisations
         WHERE deleted_at IS NOT NULL
           AND deleted_at < NOW() - ($1 || ' days')::interval`,
        [orgGraceDays.toString()]
      );
      // Audit log retention: keep at least 90 days regardless of DATA_RETENTION_DAYS,
      // since this is the compliance trail.
      const auditRetentionDays = Math.max(retentionDays, 90);
      const r5 = await query(
        `DELETE FROM audit_log WHERE created_at < NOW() - ($1 || ' days')::interval`,
        [auditRetentionDays.toString()]
      );
      logger.info(`Data retention: removed ${r1.rowCount} flash_events, ${r2.rowCount} risk_states, ${r3.rowCount} alerts, ${r4.rowCount} expired orgs, ${r5.rowCount} audit rows`);
    } catch (err) {
      logger.warn({ err }, 'Data retention job failed (non-fatal)');
    }
  };
  runRetention();
  retentionInterval = setInterval(runRetention, 6 * 60 * 60 * 1000);
}

// Run DB migrations before starting
runMigrations()
  .then(() => server.listen(PORT, async () => {
    const modeLabel = liveMode ? 'LIVE EUMETSAT' : 'IN-MEMORY MOCK';

    logger.info(`⚡ FlashAware API running on http://localhost:${PORT}`);
    logger.info(`   Health check: http://localhost:${PORT}/api/health`);
    logger.info(`   Mode: ${modeLabel}`);

    // Background jobs are gated behind a Postgres advisory lock so only one
    // machine in the fleet runs them. The HTTP API + websocket runs on every
    // machine regardless.
    startLeaderElection(startLeaderJobs).catch((err: Error) => {
      logger.error('Leader election failed', { error: err.message });
    });
  })
    .on('error', (err: Error) => {
      logger.error('Server failed to start (listen error)', { error: err.message });
      process.exit(1);
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

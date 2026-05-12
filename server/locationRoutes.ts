import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticate, requireRole, AuthRequest } from './auth';
import { resolveOrgScope, isPlatformWideUser } from './authScope';
import {
  getLocationsWithLatestState,
  createLocation,
  updateLocation,
  deleteLocation,
  getLatestRiskState,
  addRiskState,
} from './queries';
import { dispatchAlerts } from './alertService';
import { parseCentroid } from './db';
import { logger } from './logger';
import { logAudit } from './audit';
import { UUID_RE } from './validators';
import { getLocationForUser } from './routeHelpers';

const router = Router();

// ---------------------------------------------------------------------------
// Zod schemas — replace the previous ad-hoc `req.body` validation with a
// strict, typed contract. `.strict()` rejects unknown fields with a 400
// instead of silently dropping them; numeric thresholds are bounded so a
// negative or out-of-range value can't reach the DB CHECK constraints (which
// would surface as a generic 500). The shape mirrors what the dashboard
// actually sends — anything extra is a programmer error or malicious input.
// ---------------------------------------------------------------------------
const SITE_TYPES = ['mine', 'golf_course', 'construction', 'event', 'wind_farm', 'other'] as const;

const centroidSchema = z
  .object({
    lat: z.number().finite().min(-90).max(90),
    lng: z.number().finite().min(-180).max(180),
  })
  .strict();

// Threshold bounds match the DB CHECK constraints (>0) plus practical upper
// limits to guard against typos (a 999_999 km radius is almost certainly a
// stray digit, not a real config).
const thresholdsSchema = z
  .object({
    stop_radius_km: z.number().positive().max(500).optional(),
    prepare_radius_km: z.number().positive().max(500).optional(),
    stop_flash_threshold: z.number().int().positive().max(1000).optional(),
    stop_window_min: z.number().int().positive().max(1440).optional(),
    prepare_flash_threshold: z.number().int().positive().max(1000).optional(),
    prepare_window_min: z.number().int().positive().max(1440).optional(),
    allclear_wait_min: z.number().int().positive().max(1440).optional(),
    persistence_alert_min: z.number().int().positive().max(1440).optional(),
    alert_on_change_only: z.boolean().optional(),
  })
  .strict();

const createLocationSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    site_type: z.enum(SITE_TYPES).optional(),
    centroid: centroidSchema,
    timezone: z.string().min(1).max(64).optional(),
    thresholds: thresholdsSchema.optional(),
    org_id: z.string().regex(UUID_RE, 'org_id must be a valid UUID').optional(),
    is_demo: z.boolean().optional(),
  })
  .strict();

const updateLocationSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    site_type: z.enum(SITE_TYPES).optional(),
    centroid: centroidSchema.optional(),
    timezone: z.string().min(1).max(64).optional(),
    thresholds: thresholdsSchema.optional(),
    enabled: z.boolean().optional(),
    is_demo: z.boolean().optional(),
  })
  .strict();

function zodErrorResponse(res: Response, err: z.ZodError): Response {
  return res.status(400).json({
    error: 'Validation failed',
    details: err.errors.map((e: any) => ({ field: e.path.join('.'), message: e.message })),
  });
}

// Build a 0.02° "bounding box" polygon centred on the given point. The polygon
// matters for PostGIS storage; the centroid is the actual operational anchor.
function buildBoundingPolygonWkt(centroid: { lat: number; lng: number }): string {
  const { lat, lng } = centroid;
  return `POLYGON((${lng - 0.01} ${lat - 0.01}, ${lng + 0.01} ${lat - 0.01}, ${lng + 0.01} ${lat + 0.01}, ${lng - 0.01} ${lat + 0.01}, ${lng - 0.01} ${lat - 0.01}))`;
}

// Southern Africa bounding box used by the EUMETSAT ingestion filter
// (server/eumetsatService.ts: SA_BBOX). Locations outside this box can be
// created — we don't reject them — but the risk engine will only ever see
// flashes within SA, so an Antarctic location will perpetually be ALL_CLEAR
// regardless of weather. Surface a warn at create-time so an admin who
// accidentally drops a pin in the wrong continent learns about it now,
// not days later when no alerts fire during a real storm.
const SA_BBOX = { south: -36.0, north: -18.0, west: 14.0, east: 38.0 };
function isOutsideSouthernAfrica(lat: number, lng: number): boolean {
  return lat < SA_BBOX.south || lat > SA_BBOX.north || lng < SA_BBOX.west || lng > SA_BBOX.east;
}

router.get(
  '/api/locations',
  authenticate,
  requireRole('viewer'),
  async (req: AuthRequest, res: Response) => {
    try {
      const scope = resolveOrgScope(req);
      if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
      const rows = await getLocationsWithLatestState(scope.orgId);
      const result = rows.map((loc) => {
        const { lng, lat } = parseCentroid(loc.centroid);
        return { ...loc, lng, lat };
      });
      res.json(result);
    } catch (error) {
      logger.error('Failed to get locations', { error: (error as Error).message });
      res.status(500).json({ error: 'Failed to get locations' });
    }
  },
);

router.post(
  '/api/locations',
  authenticate,
  requireRole('admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const parsed = createLocationSchema.safeParse(req.body);
      if (!parsed.success) return zodErrorResponse(res, parsed.error);
      const {
        name,
        site_type,
        centroid,
        timezone,
        thresholds,
        org_id: bodyOrgId,
        is_demo,
      } = parsed.data;

      // Soft-warn (not a 4xx) — see SA_BBOX comment above.
      if (isOutsideSouthernAfrica(centroid.lat, centroid.lng)) {
        logger.warn('Location centroid is outside Southern Africa bbox', {
          lat: centroid.lat,
          lng: centroid.lng,
          name,
          orgId: req.user?.org_id,
        });
      }

      // super_admin can create locations into any org (e.g. onboarding a customer
      // before their admins are set up). Everyone else creates into their own org;
      // a non-super passing org_id gets a 403 — never silently re-routed.
      let targetOrgId = req.user!.org_id;
      if (bodyOrgId) {
        if (!isPlatformWideUser(req.user!)) {
          return res
            .status(403)
            .json({ error: 'org_id is only allowed for super_admin or representative' });
        }
        const { getOne } = await import('./db');
        const org = await getOne<{ id: string }>('SELECT id FROM organisations WHERE id = $1', [
          bodyOrgId,
        ]);
        if (!org) return res.status(404).json({ error: 'Organisation not found' });
        targetOrgId = bodyOrgId;
      }

      const geom = buildBoundingPolygonWkt(centroid);
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
        is_demo: is_demo === true,
      });

      logger.info('Location created', {
        locationId: newLoc.id,
        locationName: newLoc.name,
        createdBy: req.user?.id,
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
        requestedBy: req.user?.id,
      });
      res.status(500).json({ error: 'Failed to create location' });
    }
  },
);

router.put(
  '/api/locations/:id',
  authenticate,
  requireRole('admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      const parsed = updateLocationSchema.safeParse(req.body);
      if (!parsed.success) return zodErrorResponse(res, parsed.error);
      const { name, site_type, centroid, timezone, thresholds, enabled, is_demo } = parsed.data;

      const existingLoc = await getLocationForUser(id, req.user!);
      if (!existingLoc) return res.status(404).json({ error: 'Location not found' });

      const updates: any = {};
      if (name !== undefined) updates.name = name;
      if (site_type !== undefined) updates.site_type = site_type;
      if (centroid) {
        updates.geom = buildBoundingPolygonWkt(centroid);
        updates.centroid = `POINT(${centroid.lng} ${centroid.lat})`;
      }
      if (timezone !== undefined) updates.timezone = timezone;
      if (thresholds?.stop_radius_km !== undefined)
        updates.stop_radius_km = thresholds.stop_radius_km;
      if (thresholds?.prepare_radius_km !== undefined)
        updates.prepare_radius_km = thresholds.prepare_radius_km;
      if (thresholds?.stop_flash_threshold !== undefined)
        updates.stop_flash_threshold = thresholds.stop_flash_threshold;
      if (thresholds?.stop_window_min !== undefined)
        updates.stop_window_min = thresholds.stop_window_min;
      if (thresholds?.prepare_flash_threshold !== undefined)
        updates.prepare_flash_threshold = thresholds.prepare_flash_threshold;
      if (thresholds?.prepare_window_min !== undefined)
        updates.prepare_window_min = thresholds.prepare_window_min;
      if (thresholds?.allclear_wait_min !== undefined)
        updates.allclear_wait_min = thresholds.allclear_wait_min;
      if (thresholds?.persistence_alert_min !== undefined)
        updates.persistence_alert_min = thresholds.persistence_alert_min;
      if (thresholds?.alert_on_change_only !== undefined)
        updates.alert_on_change_only = thresholds.alert_on_change_only;
      if (is_demo !== undefined) updates.is_demo = !!is_demo;
      if (enabled !== undefined) updates.enabled = enabled;

      await updateLocation(id, updates);

      // Disable transition: when an admin flips enabled true → false the risk
      // engine simply stops evaluating this location, which would leave the last
      // (possibly STOP) state lingering on the dashboard. Write a synthetic
      // ALL_CLEAR and dispatch a stand-down alert so operators know the location
      // is no longer being monitored. Skip dispatch if the location was already
      // ALL_CLEAR — no need to re-notify on a no-op transition.
      if (existingLoc.enabled === true && updates.enabled === false) {
        try {
          const latest = await getLatestRiskState(id);
          const previousState = latest?.state ?? null;
          const nowIso = new Date().toISOString();
          const reason =
            'Location disabled by admin — monitoring paused. ALL_CLEAR forced; the engine will not evaluate this site until it is re-enabled.';
          const stateId = await addRiskState({
            location_id: id,
            state: 'ALL_CLEAR',
            previous_state: previousState,
            changed_at: nowIso,
            reason: { reason, source: 'admin_disable', actor: req.user?.id },
            flashes_in_stop_radius: 0,
            flashes_in_prepare_radius: 0,
            nearest_flash_km: null,
            data_age_sec: 0,
            is_degraded: false,
            evaluated_at: nowIso,
          });
          if (previousState && previousState !== 'ALL_CLEAR') {
            await dispatchAlerts(id, BigInt(stateId), 'ALL_CLEAR', reason);
          }
        } catch (disableErr) {
          // Best-effort cleanup so the UI reflects reality. Don't fail the PUT —
          // the row is already disabled.
          logger.error('Failed to write synthetic ALL_CLEAR on disable', {
            locationId: id,
            error: (disableErr as Error).message,
          });
        }
      }

      logger.info('Location updated', {
        locationId: id,
        updatedBy: req.user?.id,
        fields: Object.keys(updates),
      });
      await logAudit({
        req,
        action: 'location.update',
        target_type: 'location',
        target_id: id,
        target_org_id: existingLoc.org_id,
        before: {
          name: existingLoc.name,
          site_type: existingLoc.site_type,
          enabled: existingLoc.enabled,
        },
        after: updates,
      });

      res.json({ success: true });
    } catch (error) {
      logger.error('Failed to update location', {
        error: (error as Error).message,
        requestedBy: req.user?.id,
        locationId: req.params.id,
      });
      res.status(500).json({ error: 'Failed to update location' });
    }
  },
);

router.delete(
  '/api/locations/:id',
  authenticate,
  requireRole('admin'),
  async (req: AuthRequest, res: Response) => {
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
      logger.error('Failed to delete location', {
        error: (error as Error).message,
        locationId: req.params.id,
      });
      res.status(500).json({ error: 'Failed to delete location' });
    }
  },
);

export default router;

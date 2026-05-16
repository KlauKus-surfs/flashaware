import { Router, Response } from 'express';
import { authenticate, requireRole, AuthRequest } from './auth';
import { resolveOrgScope } from './authScope';
import {
  getLocationsWithLatestState,
  getLatestRiskState,
  getRecentRiskStates,
  getRecentFlashes,
} from './queries';
import { parseCentroid } from './db';
import { logger } from './logger';
import { getLocationForUser } from './routeHelpers';

const router = Router();

// Haversine distance — kept inline so the file has no cross-route imports.
// Same formula as the legacy helper that lived at the bottom of index.ts.
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// -- Status: dashboard summary across an org's enabled locations --
router.get(
  '/api/status',
  authenticate,
  requireRole('viewer'),
  async (req: AuthRequest, res: Response) => {
    try {
      const scope = resolveOrgScope(req);
      if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
      const rows = await getLocationsWithLatestState(scope.orgId, { enabledOnly: true });
      const stateOrder: Record<string, number> = {
        STOP: 1,
        HOLD: 2,
        DEGRADED: 3,
        PREPARE: 4,
        ALL_CLEAR: 5,
      };

      const statuses = rows.map((loc) => {
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
          is_demo: loc.is_demo,
          active_recipient_count: loc.active_recipient_count,
        };
      });

      statuses.sort(
        (a, b) =>
          (stateOrder[a.state || 'ALL_CLEAR'] || 5) - (stateOrder[b.state || 'ALL_CLEAR'] || 5) ||
          a.name.localeCompare(b.name),
      );

      res.json(statuses);
    } catch (error) {
      logger.error('Failed to get status', { error: (error as Error).message });
      res.status(500).json({ error: 'Failed to get status' });
    }
  },
);

// -- Status detail: single-location view with recent states + nearby flashes --
router.get(
  '/api/status/:locationId',
  authenticate,
  requireRole('viewer'),
  async (req: AuthRequest, res: Response) => {
    try {
      const { locationId } = req.params;
      const location = await getLocationForUser(locationId, req.user!);
      if (!location) return res.status(404).json({ error: 'Location not found' });

      const [currentState, recentStates, nearbyFlashes] = await Promise.all([
        getLatestRiskState(locationId),
        getRecentRiskStates(locationId),
        getRecentFlashes(undefined, 30).then((flashes) => {
          const { lng, lat } = parseCentroid(location.centroid);
          return flashes
            .map((f) => ({
              ...f,
              distance_km: calculateDistance(lat, lng, f.latitude, f.longitude),
            }))
            .filter((f) => f.distance_km <= (location.prepare_radius_km || 20))
            .sort(
              (a, b) => new Date(b.flash_time_utc).getTime() - new Date(a.flash_time_utc).getTime(),
            );
        }),
      ]);

      res.json({ location, currentState, recentStates, nearbyFlashes });
    } catch (error) {
      logger.error('Failed to get location status', {
        error: (error as Error).message,
        locationId: req.params.locationId,
      });
      res.status(500).json({ error: 'Failed to get location status' });
    }
  },
);

// -- Recent flashes (bbox + minutes filter) --
router.get('/api/flashes', authenticate, requireRole('viewer'), async (req, res) => {
  try {
    const { west, south, east, north, minutes, limit } = req.query;
    const bbox =
      west && south && east && north
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

// -- Replay: states + flashes for a location over a lookback window --
//
// Wide-area visibility: we deliberately query a fixed 200 km radius around the
// location centroid rather than the location's prepare_radius_km. The risk
// engine still evaluates only inside stop/prepare radii — this expanded query
// is purely for the Replay UI so an operator can see strikes that came close
// to (but never crossed into) their alerting envelope. The client classifies
// each returned flash into a 4-band heatmap using distance_km vs the location's
// own radii, so the server doesn't need to filter by the location's own range.
router.get(
  '/api/replay/:locationId',
  authenticate,
  requireRole('viewer'),
  async (req: AuthRequest, res: Response) => {
    try {
      const { locationId } = req.params;
      const lookback = Math.min(Math.max(parseInt(req.query.hours as string) || 24, 1), 168);

      const loc = await getLocationForUser(locationId, req.user!);
      if (!loc) return res.status(404).json({ error: 'Location not found' });

      const { lng, lat } = parseCentroid(loc.centroid);

      const { query: dbQuery } = await import('./db');
      const statesRes = await dbQuery(
        `SELECT * FROM risk_states
         WHERE location_id = $1
           AND evaluated_at >= NOW() - ($2 || ' hours')::interval
         ORDER BY evaluated_at ASC`,
        [locationId, lookback.toString()],
      );

      // Fixed wide-area radius for Replay context. 200 km is the design ceiling
      // for "useful context" without exploding payload size on storm days.
      const WIDE_RADIUS_M = 200_000; // 200 km
      const FLASH_LIMIT = 5000;

      const centroidWkt = `POINT(${lng} ${lat})`;
      // LIMIT FLASH_LIMIT+1 so we can detect overflow without a second COUNT.
      const flashesRes = await dbQuery(
        `SELECT flash_id, flash_time_utc, latitude, longitude, radiance,
                duration_ms, filter_confidence,
                ST_Distance(geom::geography, ST_GeomFromText($1, 4326)::geography) / 1000.0 AS distance_km
         FROM flash_events
         WHERE flash_time_utc >= NOW() - ($2 || ' hours')::interval
           AND ST_DWithin(geom::geography, ST_GeomFromText($1, 4326)::geography, $3)
         ORDER BY flash_time_utc ASC
         LIMIT ${FLASH_LIMIT + 1}`,
        [centroidWkt, lookback.toString(), WIDE_RADIUS_M],
      );

      // Correlate state transitions with dispatched alerts using the FK
      // `alerts.state_id -> risk_states.id` (see db/schema.sql). The FK is
      // populated by riskEngine / alertService at dispatch time, so this is
      // the authoritative link between an alert and the transition that
      // produced it — no time-window heuristic needed.
      const alertsRes = await dbQuery(
        `SELECT a.id AS alert_id, a.sent_at, rs.id AS transition_id
         FROM alerts a
         JOIN risk_states rs ON rs.id = a.state_id
         WHERE a.location_id = $1
           AND a.sent_at >= NOW() - ($2 || ' hours')::interval
           AND rs.evaluated_at >= NOW() - ($2 || ' hours')::interval`,
        [locationId, lookback.toString()],
      );

      const truncated = flashesRes.rows.length > FLASH_LIMIT;
      const flashes = truncated ? flashesRes.rows.slice(0, FLASH_LIMIT) : flashesRes.rows;

      const locationPayload = {
        id: loc.id,
        name: loc.name,
        lat,
        lng,
        stop_radius_km: loc.stop_radius_km,
        prepare_radius_km: loc.prepare_radius_km,
        stop_window_min: loc.stop_window_min,
        prepare_window_min: loc.prepare_window_min,
      };

      const lightningSource = (process.env.LIGHTNING_SOURCE || 'lfl').toLowerCase();
      if (lightningSource === 'afa') {
        const startIso = new Date(Date.now() - lookback * 60 * 60 * 1000).toISOString();
        const endIso = new Date().toISOString();
        const replayRadiusKm = WIDE_RADIUS_M / 1000;

        const afaRes = await dbQuery(
          `SELECT observed_at_utc, pixel_lat, pixel_lon, flash_count,
                  ST_AsGeoJSON(geom)::json AS geometry
             FROM afa_pixels
            WHERE observed_at_utc BETWEEN $1 AND $2
              AND ST_DWithin(geom::geography, ST_GeomFromText($3, 4326)::geography, $4)
           ORDER BY observed_at_utc`,
          [startIso, endIso, centroidWkt, replayRadiusKm * 1000],
        );

        return res.json({
          source: 'afa',
          location: locationPayload,
          states: statesRes.rows,
          triggered_alerts: alertsRes.rows,
          type: 'FeatureCollection',
          features: afaRes.rows.map((r) => ({
            type: 'Feature',
            geometry: r.geometry,
            properties: {
              observed_at_utc: r.observed_at_utc,
              pixel_lat: r.pixel_lat,
              pixel_lon: r.pixel_lon,
              flash_count: r.flash_count,
            },
          })),
        });
      }

      res.json({
        source: 'lfl',
        location: locationPayload,
        states: statesRes.rows,
        flashes,
        flashes_truncated: truncated,
        wide_radius_km: WIDE_RADIUS_M / 1000,
        triggered_alerts: alertsRes.rows,
      });
    } catch (error) {
      logger.error('Failed to get replay data', {
        error: (error as Error).message,
        locationId: req.params.locationId,
      });
      res.status(500).json({ error: 'Failed to get replay data' });
    }
  },
);

export default router;

import { Pool, QueryResult } from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { dbLogger } from './logger';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const dbUrl = process.env.DATABASE_URL
  ? (() => {
      const u = new URL(process.env.DATABASE_URL);
      u.searchParams.set('target_session_attrs', 'read-write');
      return u.toString();
    })()
  : undefined;

const pool = dbUrl
  ? new Pool({
      connectionString: dbUrl,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    })
  : new Pool({
      host: process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || '5432'),
      user: process.env.POSTGRES_USER || 'lightning',
      password: process.env.POSTGRES_PASSWORD || 'lightning_dev',
      database: process.env.POSTGRES_DB || 'lightning_risk',
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

pool.on('error', (err) => {
  dbLogger.error({ err }, 'Unexpected error on idle client');
});

// Parse PostGIS WKT "POINT(lng lat)" → { lng, lat }. Returns { lng: 0, lat: 0 }
// on a malformed input but logs at ERROR level — a {0,0} fallback puts a
// location at the Gulf of Guinea, far outside any SA bbox, which is a hard
// bug to spot in the wild. Logging at error means the malformed-centroid
// case shows up on standard alert dashboards rather than disappearing into
// debug noise. We deliberately don't throw because parseCentroid is called
// on every status-list response, and one bad location row shouldn't 500
// the whole list.
export function parseCentroid(wkt: string | null | undefined): { lng: number; lat: number } {
  if (!wkt) {
    dbLogger.error('parseCentroid: empty/missing WKT input — falling back to (0,0)');
    return { lng: 0, lat: 0 };
  }
  const m = String(wkt).match(/POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/i);
  if (!m) {
    dbLogger.error(
      { wkt: String(wkt).slice(0, 80) },
      'parseCentroid: failed to parse WKT — falling back to (0,0)',
    );
    return { lng: 0, lat: 0 };
  }
  return { lng: parseFloat(m[1]), lat: parseFloat(m[2]) };
}

export async function query(text: string, params?: any[]): Promise<QueryResult> {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  if (duration > 1000) {
    dbLogger.warn({ durationMs: duration, sql: text.substring(0, 100) }, 'Slow query');
  }
  return result;
}

export async function getOne<T = any>(text: string, params?: any[]): Promise<T | null> {
  const result = await query(text, params);
  return result.rows[0] || null;
}

export async function getMany<T = any>(text: string, params?: any[]): Promise<T[]> {
  const result = await query(text, params);
  return result.rows;
}

// Spatial query helpers for the risk engine.
//
// Every query takes an optional `now` parameter so the entire engine tick
// can reference a single instant. Without this, the freshness check uses
// `Date.now()` snapshotted in JS while the spatial queries each call
// Postgres's NOW() at execution time — across a 300-location tick that
// drift can be many seconds, producing "feed healthy + zero flashes →
// ALL_CLEAR" when in reality the feed crossed the staleness boundary
// mid-tick. Passing `now` makes the time reference deterministic and
// testable. Callers without a tick instant can pass `undefined` and we
// fall back to NOW() (legacy / one-off callers / tests).
function withNow(now: Date | undefined, sql: string): string {
  // Cast the ISO-string param to timestamptz so Postgres interval arithmetic
  // works. Without the cast, `$1 - interval '5 minutes'` would 42883.
  return now === undefined
    ? sql.replace(/\$NOW\$/g, 'NOW()')
    : sql.replace(/\$NOW\$/g, '$1::timestamptz');
}
function nowParams(now: Date | undefined, params: any[]): any[] {
  return now === undefined ? params : [now.toISOString(), ...params];
}
function shift(now: Date | undefined, n: number): string {
  return now === undefined ? `$${n}` : `$${n + 1}`;
}

export async function countFlashesInRadius(
  centroidWkt: string,
  radiusKm: number,
  windowMinutes: number,
  now?: Date,
): Promise<number> {
  const sql = withNow(
    now,
    `SELECT COUNT(*) AS cnt
       FROM flash_events
      WHERE ST_DWithin(geom::geography, ST_GeomFromText(${shift(now, 1)}, 4326)::geography, ${shift(now, 2)})
        AND flash_time_utc >= $NOW$ - (${shift(now, 3)} || ' minutes')::interval`,
  );
  const result = await query(
    sql,
    nowParams(now, [centroidWkt, radiusKm * 1000, windowMinutes.toString()]),
  );
  return parseInt(result.rows[0].cnt, 10);
}

export async function getNearestFlashDistance(
  centroidWkt: string,
  windowMinutes: number,
  now?: Date,
): Promise<number | null> {
  const sql = withNow(
    now,
    `SELECT ST_Distance(geom::geography, ST_GeomFromText(${shift(now, 1)}, 4326)::geography) / 1000.0 AS dist_km
       FROM flash_events
      WHERE flash_time_utc >= $NOW$ - (${shift(now, 2)} || ' minutes')::interval
   ORDER BY geom::geography <-> ST_GeomFromText(${shift(now, 1)}, 4326)::geography
      LIMIT 1`,
  );
  const result = await query(sql, nowParams(now, [centroidWkt, windowMinutes.toString()]));
  return result.rows[0]?.dist_km ?? null;
}

export async function getTimeSinceLastFlashInRadius(
  centroidWkt: string,
  radiusKm: number,
  allclearWaitMin: number,
  now?: Date,
): Promise<number | null> {
  const sql = withNow(
    now,
    `SELECT EXTRACT(EPOCH FROM ($NOW$ - MAX(flash_time_utc))) / 60.0 AS minutes_ago
       FROM flash_events
      WHERE ST_DWithin(geom::geography, ST_GeomFromText(${shift(now, 1)}, 4326)::geography, ${shift(now, 2)})
        AND flash_time_utc >= $NOW$ - (${shift(now, 3)} || ' minutes')::interval`,
  );
  const result = await query(
    sql,
    nowParams(now, [centroidWkt, radiusKm * 1000, allclearWaitMin.toString()]),
  );
  return result.rows[0]?.minutes_ago ?? null;
}

/**
 * Latest INGESTED product time. Previously keyed on `product_time_end` (the
 * sensing window end), which had two failure modes:
 *   • A backfill of a 2-hour-old product instantly bumped "latest" to a
 *     2-hour-old timestamp, flipping every location to DEGRADED.
 *   • A clock-skewed sensing timestamp could mark stale data as fresh.
 * The right signal for "is the FEED healthy" is when WE last received a
 * product, not what the satellite was looking at — so we now read
 * `ingested_at`. We also broaden the qc_status exclusion to filter out
 * DOWNLOAD_FAILED so a flapping endpoint can't masquerade as a healthy feed
 * (only successful or low-count parses count toward freshness).
 */
export async function getLatestIngestionTime(): Promise<Date | null> {
  const result = await query(
    `SELECT MAX(ingested_at) AS latest
       FROM ingestion_log
      WHERE qc_status NOT IN ('ERROR', 'DOWNLOAD_FAILED')`,
  );
  return result.rows[0]?.latest ?? null;
}

export async function getFlashTrend(
  centroidWkt: string,
  radiusKm: number,
  now?: Date,
): Promise<{ recent: number; previous: number; trend: string }> {
  const recentSql = withNow(
    now,
    `SELECT COUNT(*) AS cnt FROM flash_events
       WHERE ST_DWithin(geom::geography, ST_GeomFromText(${shift(now, 1)}, 4326)::geography, ${shift(now, 2)})
         AND flash_time_utc >= $NOW$ - interval '5 minutes'`,
  );
  const previousSql = withNow(
    now,
    `SELECT COUNT(*) AS cnt FROM flash_events
       WHERE ST_DWithin(geom::geography, ST_GeomFromText(${shift(now, 1)}, 4326)::geography, ${shift(now, 2)})
         AND flash_time_utc >= $NOW$ - interval '15 minutes'
         AND flash_time_utc <  $NOW$ - interval '5 minutes'`,
  );
  const [recentRes, previousRes] = await Promise.all([
    query(recentSql, nowParams(now, [centroidWkt, radiusKm * 1000])),
    query(previousSql, nowParams(now, [centroidWkt, radiusKm * 1000])),
  ]);

  const recent = parseInt(recentRes.rows[0].cnt, 10);
  const previous = parseInt(previousRes.rows[0].cnt, 10);
  let trend = 'stable';
  if (recent > previous * 1.5) trend = 'increasing';
  else if (recent < previous * 0.5) trend = 'decreasing';

  return { recent, previous, trend };
}

export async function getRecentFlashes(
  bbox?: { west: number; south: number; east: number; north: number },
  minutes: number = 30,
  limit: number = 10000,
) {
  // Hard cap: callers can ask for fewer rows but never more than 50k. A whole
  // year of severe Africa storms with this kind of envelope can exceed 100k+
  // events, and we don't want to OOM the server fetching them.
  const cappedLimit = Math.min(Math.max(limit, 1), 50_000);

  let sql = `SELECT flash_id, flash_time_utc, latitude, longitude, radiance,
                    duration_ms, duration_clamped_ms, footprint, num_groups,
                    num_events, filter_confidence, is_truncated, product_id
             FROM flash_events
             WHERE flash_time_utc >= NOW() - make_interval(mins => $1)`;
  const params: any[] = [minutes];

  if (bbox) {
    sql += ` AND ST_Within(geom, ST_MakeEnvelope($2, $3, $4, $5, 4326))`;
    params.push(bbox.west, bbox.south, bbox.east, bbox.north);
  }

  sql += ` ORDER BY flash_time_utc DESC LIMIT ${cappedLimit}`;
  return getMany(sql, params);
}

export { pool };

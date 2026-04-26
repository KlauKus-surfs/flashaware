import { Pool, QueryResult } from 'pg';
import dotenv from 'dotenv';
import path from 'path';

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
  console.error('Unexpected error on idle client', err);
});

export async function query(text: string, params?: any[]): Promise<QueryResult> {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  if (duration > 1000) {
    console.warn(`Slow query (${duration}ms):`, text.substring(0, 100));
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

// Spatial query helpers for the risk engine
export async function countFlashesInRadius(
  centroidWkt: string,
  radiusKm: number,
  windowMinutes: number
): Promise<number> {
  const result = await query(
    `SELECT COUNT(*) AS cnt
     FROM flash_events
     WHERE ST_DWithin(geom::geography, ST_GeomFromText($1, 4326)::geography, $2)
       AND flash_time_utc >= NOW() - ($3 || ' minutes')::interval`,
    [centroidWkt, radiusKm * 1000, windowMinutes.toString()]
  );
  return parseInt(result.rows[0].cnt, 10);
}

export async function getNearestFlashDistance(
  centroidWkt: string,
  windowMinutes: number
): Promise<number | null> {
  const result = await query(
    `SELECT ST_Distance(geom::geography, ST_GeomFromText($1, 4326)::geography) / 1000.0 AS dist_km
     FROM flash_events
     WHERE flash_time_utc >= NOW() - ($2 || ' minutes')::interval
     ORDER BY geom::geography <-> ST_GeomFromText($1, 4326)::geography
     LIMIT 1`,
    [centroidWkt, windowMinutes.toString()]
  );
  return result.rows[0]?.dist_km ?? null;
}


export async function getTimeSinceLastFlashInRadius(
  centroidWkt: string,
  radiusKm: number,
  allclearWaitMin: number
): Promise<number | null> {
  const result = await query(
    `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(flash_time_utc))) / 60.0 AS minutes_ago
     FROM flash_events
     WHERE ST_DWithin(geom::geography, ST_GeomFromText($1, 4326)::geography, $2)
       AND flash_time_utc >= NOW() - ($3 || ' minutes')::interval`,
    [centroidWkt, radiusKm * 1000, allclearWaitMin.toString()]
  );
  return result.rows[0]?.minutes_ago ?? null;
}

export async function getLatestIngestionTime(): Promise<Date | null> {
  const result = await query(
    `SELECT MAX(product_time_end) AS latest FROM ingestion_log WHERE qc_status != 'ERROR'`
  );
  return result.rows[0]?.latest ?? null;
}

export async function getFlashTrend(
  centroidWkt: string,
  radiusKm: number
): Promise<{ recent: number; previous: number; trend: string }> {
  const [recentRes, previousRes] = await Promise.all([
    query(
      `SELECT COUNT(*) AS cnt FROM flash_events
       WHERE ST_DWithin(geom::geography, ST_GeomFromText($1, 4326)::geography, $2)
         AND flash_time_utc >= NOW() - interval '5 minutes'`,
      [centroidWkt, radiusKm * 1000]
    ),
    query(
      `SELECT COUNT(*) AS cnt FROM flash_events
       WHERE ST_DWithin(geom::geography, ST_GeomFromText($1, 4326)::geography, $2)
         AND flash_time_utc >= NOW() - interval '15 minutes'
         AND flash_time_utc < NOW() - interval '5 minutes'`,
      [centroidWkt, radiusKm * 1000]
    ),
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
  limit: number = 10000
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

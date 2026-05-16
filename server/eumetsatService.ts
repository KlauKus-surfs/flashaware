/**
 * EUMETSAT Data Store Integration Service
 * Handles OAuth2 authentication, product discovery, download, and ingestion
 * of live MTG Lightning Imager (LI-2-LFL) flash data.
 *
 * Falls back to mock simulation when credentials are not configured.
 */

import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import AdmZip from 'adm-zip';
import { DateTime } from 'luxon';
import { query } from './db';
import { ingestionLogger } from './logger';

// ============================================================
// Configuration
// ============================================================

const TOKEN_URL = 'https://api.eumetsat.int/token';
const SEARCH_URL = 'https://api.eumetsat.int/data/search-products/1.0.0/os';
const DOWNLOAD_BASE = 'https://api.eumetsat.int/data/download/1.0.0/collections';

const DATA_DIR = path.resolve(__dirname, '..', 'ingestion', 'data');
const localParserPath = path.resolve(__dirname, '..', 'ingestion', 'parse_nc_json.py');
const dockerParserPath = path.resolve(__dirname, '..', 'parse_nc_json.py');
const PARSER_SCRIPT = fs.existsSync(localParserPath) ? localParserPath : dockerParserPath;

interface TokenCache {
  access_token: string;
  expires_at: number;
}

let cachedToken: TokenCache | null = null;
let ingestionTimer: ReturnType<typeof setTimeout> | null = null;
let ingestionStopped = false;
let isIngesting = false;

// ============================================================
// Auth
// ============================================================

export function hasCredentials(): boolean {
  const key = process.env.EUMETSAT_CONSUMER_KEY || '';
  const secret = process.env.EUMETSAT_CONSUMER_SECRET || '';
  return (
    key.length > 5 &&
    secret.length > 5 &&
    key !== 'your-consumer-key' &&
    secret !== 'your-consumer-secret'
  );
}

async function getAccessToken(): Promise<string> {
  const key = process.env.EUMETSAT_CONSUMER_KEY!;
  const secret = process.env.EUMETSAT_CONSUMER_SECRET!;

  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && Date.now() < cachedToken.expires_at - 60_000) {
    return cachedToken.access_token;
  }

  const auth = Buffer.from(`${key}:${secret}`).toString('base64');

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Token request failed (${resp.status}): ${body}`);
  }

  const data = (await resp.json()) as any;
  cachedToken = {
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
  };

  ingestionLogger.info('EUMETSAT access token acquired');
  return cachedToken.access_token;
}

// ============================================================
// Product Search
// ============================================================

interface ProductInfo {
  id: string;
  title: string;
  sensing_start: string | null;
  sensing_end: string | null;
  size: number | null;
}

async function searchProducts(lookbackMinutes: number = 60): Promise<ProductInfo[]> {
  const token = await getAccessToken();
  const collectionId = process.env.EUMETSAT_COLLECTION_ID || 'EO:EUM:DAT:0691';

  const now = DateTime.utc();
  const start = now.minus({ minutes: lookbackMinutes });

  const params = new URLSearchParams({
    pi: collectionId,
    dtstart: start.toISO()!,
    dtend: now.toISO()!,
    format: 'json',
    si: '0',
    c: '20',
    sort: 'start,time,0',
  });

  const resp = await fetch(`${SEARCH_URL}?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Product search failed (${resp.status}): ${body}`);
  }

  const data = (await resp.json()) as any;

  // OpenSearch GeoJSON response
  const features = data.features || [];
  return features.map((f: any) => {
    const props = f.properties || {};
    const dateRange = props.date || '';
    const [dtStart, dtEnd] = dateRange.split('/');
    return {
      id: f.id || props.identifier || props.title,
      title: props.title || f.id || 'unknown',
      sensing_start: dtStart || null,
      sensing_end: dtEnd || null,
      size: props.size || null,
    };
  });
}

// ============================================================
// Product Download
// ============================================================

async function downloadProduct(productId: string): Promise<string | null> {
  const token = await getAccessToken();
  const collectionId = process.env.EUMETSAT_COLLECTION_ID || 'EO:EUM:DAT:0691';
  const encodedCollection = encodeURIComponent(collectionId);
  const encodedProduct = encodeURIComponent(productId);

  const url = `${DOWNLOAD_BASE}/${encodedCollection}/products/${encodedProduct}`;

  ingestionLogger.info({ productId }, 'EUMETSAT downloading product');
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    ingestionLogger.error({ productId, status: resp.status }, 'EUMETSAT download failed');
    return null;
  }

  // Ensure data directory exists
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const buffer = Buffer.from(await resp.arrayBuffer());

  // Try to extract as ZIP containing NetCDF
  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();

    // Look for BODY .nc file (contains flash data)
    const bodyEntry = entries.find(
      (e) => e.entryName.includes('CHK-BODY') && e.entryName.endsWith('.nc'),
    );

    if (bodyEntry) {
      const outPath = path.join(DATA_DIR, path.basename(bodyEntry.entryName));
      zip.extractEntryTo(bodyEntry, DATA_DIR, false, true);
      ingestionLogger.info({ file: path.basename(bodyEntry.entryName) }, 'EUMETSAT extracted BODY');
      return outPath;
    }

    // If no BODY file, look for any .nc file
    const ncEntry = entries.find((e) => e.entryName.endsWith('.nc'));
    if (ncEntry) {
      const outPath = path.join(DATA_DIR, path.basename(ncEntry.entryName));
      zip.extractEntryTo(ncEntry, DATA_DIR, false, true);
      ingestionLogger.info({ file: path.basename(ncEntry.entryName) }, 'EUMETSAT extracted NC');
      return outPath;
    }

    ingestionLogger.warn({ productId }, 'EUMETSAT: no .nc files found in ZIP');
    return null;
  } catch {
    // Not a ZIP — might be a raw NetCDF file
    const outPath = path.join(DATA_DIR, `${productId.replace(/[^a-zA-Z0-9_-]/g, '_')}.nc`);
    fs.writeFileSync(outPath, buffer);
    ingestionLogger.info({ file: path.basename(outPath) }, 'EUMETSAT saved raw file');
    return outPath;
  }
}

// ============================================================
// NetCDF Parsing (via Python subprocess)
// ============================================================

interface ParsedFlash {
  flash_id: number;
  flash_time_utc: string;
  latitude: number;
  longitude: number;
  radiance: number | null;
  duration_ms: number | null;
  duration_clamped_ms: number | null;
  footprint: number | null;
  num_groups: number;
  num_events: number;
  filter_confidence: number | null;
  is_truncated: boolean;
}

function parseNetCDF(ncPath: string): Promise<ParsedFlash[]> {
  return new Promise((resolve, reject) => {
    const python = process.platform === 'win32' ? 'python' : 'python3';
    const proc = spawn(python, [PARSER_SCRIPT, ncPath]);

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    // Node's spawn `timeout` option does not reliably kill on all platforms.
    // We do it explicitly: SIGTERM, then SIGKILL after a grace period.
    const softTimeout = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, 60_000);
    const hardTimeout = setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL');
    }, 65_000);

    const cleanup = () => {
      clearTimeout(softTimeout);
      clearTimeout(hardTimeout);
    };

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code, signal) => {
      cleanup();
      if (timedOut) {
        reject(
          new Error(`Python parser timed out after 60s and was killed (${signal || 'SIGTERM'})`),
        );
        return;
      }
      if (code !== 0) {
        reject(new Error(`Python parser exited with code ${code}: ${stderr}`));
        return;
      }
      try {
        const flashes = JSON.parse(stdout);
        resolve(flashes);
      } catch (e) {
        reject(new Error(`Failed to parse Python output: ${(e as Error).message}`));
      }
    });

    proc.on('error', (err) => {
      cleanup();
      reject(
        new Error(
          `Failed to spawn Python: ${err.message}. Ensure Python and netCDF4 are installed.`,
        ),
      );
    });
  });
}

// ============================================================
// AFA NetCDF Parsing + Ingestion (via Python subprocess)
// ============================================================

interface ParsedAfaPixel {
  observed_at_utc: string;
  pixel_lat: number;
  pixel_lon: number;
  flash_count: number;
  geom_wkt: string;
}

const localAfaParser = path.resolve(__dirname, '..', 'ingestion', 'parse_afa_nc_json.py');
const dockerAfaParser = path.resolve(__dirname, '..', 'parse_afa_nc_json.py');
const AFA_PARSER_SCRIPT = fs.existsSync(localAfaParser) ? localAfaParser : dockerAfaParser;

function parseAfaNetCDF(ncPath: string): Promise<ParsedAfaPixel[]> {
  return new Promise((resolve, reject) => {
    const python = process.platform === 'win32' ? 'python' : 'python3';
    const proc = spawn(python, [AFA_PARSER_SCRIPT, ncPath]);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const soft = setTimeout(() => { timedOut = true; proc.kill('SIGTERM'); }, 60_000);
    const hard = setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 65_000);
    proc.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    proc.on('close', (code, signal) => {
      clearTimeout(soft); clearTimeout(hard);
      if (timedOut) return reject(new Error(`AFA parser timed out (${signal})`));
      if (code !== 0) return reject(new Error(`AFA parser exit ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(new Error(`AFA parser bad JSON: ${(e as Error).message}`)); }
    });
    proc.on('error', (err) => {
      clearTimeout(soft); clearTimeout(hard);
      reject(new Error(`Failed to spawn Python for AFA: ${err.message}`));
    });
  });
}

async function ingestAfaPixels(
  pixels: ParsedAfaPixel[],
  productId: string,
): Promise<{ total: number; ingested: number }> {
  let ingested = 0;
  for (const p of pixels) {
    try {
      await query(
        `INSERT INTO afa_pixels (
           product_id, observed_at_utc, pixel_lat, pixel_lon, geom, flash_count
         ) VALUES ($1, $2, $3, $4, ST_GeomFromText($5, 4326), $6)
         ON CONFLICT DO NOTHING`,
        [productId, p.observed_at_utc, p.pixel_lat, p.pixel_lon, p.geom_wkt, p.flash_count],
      );
      ingested++;
    } catch (err) {
      ingestionLogger.warn('Failed to insert AFA pixel', {
        productId, lat: p.pixel_lat, lon: p.pixel_lon,
        error: (err as Error).message,
      });
    }
  }
  return { total: pixels.length, ingested };
}

// ============================================================
// Ingest flashes into PostgreSQL
// ============================================================

// Southern Africa bounding box (generous buffer for approaching storms)
const SA_BBOX = { south: -36.0, north: -18.0, west: 14.0, east: 38.0 };

function isInSouthernAfrica(lat: number, lng: number): boolean {
  return lat >= SA_BBOX.south && lat <= SA_BBOX.north && lng >= SA_BBOX.west && lng <= SA_BBOX.east;
}

async function ingestFlashes(
  flashes: ParsedFlash[],
  productId: string,
): Promise<{ total: number; ingested: number }> {
  let ingested = 0;

  for (const f of flashes) {
    if (!isInSouthernAfrica(f.latitude, f.longitude)) continue;

    try {
      await query(
        `INSERT INTO flash_events (
          flash_id, flash_time_utc, geom, latitude, longitude,
          radiance, duration_ms, duration_clamped_ms, footprint,
          num_groups, num_events, filter_confidence, is_truncated, product_id
        ) VALUES (
          $1, $2, ST_SetSRID(ST_MakePoint($4, $3), 4326), $3, $4,
          $5, $6, $7, $8, $9, $10, $11, $12, $13
        ) ON CONFLICT DO NOTHING`,
        [
          f.flash_id,
          f.flash_time_utc,
          f.latitude,
          f.longitude,
          f.radiance,
          f.duration_ms,
          f.duration_clamped_ms,
          f.footprint,
          f.num_groups || 1,
          f.num_events || 1,
          f.filter_confidence,
          f.is_truncated || false,
          productId,
        ],
      );
      ingested++;
    } catch (err) {
      ingestionLogger.warn('Failed to insert flash', {
        flashId: f.flash_id,
        error: (err as Error).message,
      });
    }
  }

  return { total: flashes.length, ingested };
}

// ============================================================
// Full ingestion cycle
// ============================================================

// Best-effort heartbeat write into app_settings. Surfaced via /api/health
// → collector.{lastSuccessAt,lastAttemptAt}. Failures are swallowed: missing
// observability is a worse outcome than crashing the ingestion loop over a
// transient DB issue.
//
// Keys are namespaced `api_ingester_*` to disambiguate from the historical
// Python `collector_*` keys: the standalone Python collector is dev-only
// (see ingestion/collector.py docstring), but a developer running it locally
// against the same DB used to overwrite this heartbeat — making the
// /api/health "collector" panel report the last-running ingester rather than
// the API's own ingestion liveness. With distinct keys, the dashboard always
// reflects the in-process ingester regardless of who else is poking the DB.
async function writeHeartbeat(
  key: 'api_ingester_last_attempt_at' | 'api_ingester_last_success_at',
) {
  try {
    await query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, NOW()::text, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key],
    );
  } catch (err) {
    ingestionLogger.warn('Heartbeat write failed', {
      key,
      error: (err as Error).message,
    });
  }
}

async function runIngestionCycle(): Promise<void> {
  if (isIngesting) {
    ingestionLogger.warn('EUMETSAT: previous ingestion still running, skipping');
    return;
  }
  isIngesting = true;

  // Bumped on every cycle entry so a stale lastAttemptAt means the loop is
  // dead/wedged. Distinct from lastSuccessAt below, which only bumps if we
  // actually reached EUMETSAT.
  await writeHeartbeat('api_ingester_last_attempt_at');

  try {
    ingestionLogger.info(
      { startedAt: DateTime.utc().toISO() },
      'EUMETSAT starting ingestion cycle',
    );

    // 1. Search for recent products
    const products = await searchProducts(60);
    ingestionLogger.info({ count: products.length }, 'EUMETSAT product search');
    // searchProducts returned without throwing → handshake with EUMETSAT
    // succeeded. Empty `products` is not a failure (quiet weather).
    await writeHeartbeat('api_ingester_last_success_at');

    if (products.length === 0) {
      return;
    }

    // 2. Filter already-processed products via the durable ingestion_log.
    // Process-local dedup used to live in a Set<string> here — but that set
    // started empty after every restart, so a cold boot re-downloaded and
    // re-parsed every product within the 60-min lookback window. The DB
    // INSERT ... ON CONFLICT DO NOTHING saved the data layer but the
    // download + Python parse cost was paid every restart. Now we ask the
    // database which product_ids we've already seen and skip those — the
    // table is the source of truth and survives restart, redeploy, and
    // leader failover.
    let alreadyProcessed = new Set<string>();
    try {
      const productIds = products.map((p) => p.id);
      const { rows } = await query(
        `SELECT product_id FROM ingestion_log WHERE product_id = ANY($1)`,
        [productIds],
      );
      alreadyProcessed = new Set(rows.map((r) => r.product_id as string));
    } catch (err) {
      // Soft-fail dedup: if the lookup throws (transient DB issue), fall
      // back to "process everything" — INSERT ON CONFLICT will keep the
      // flash table consistent. Re-parsing some products is wasted work
      // but never produces duplicates.
      ingestionLogger.warn('EUMETSAT dedup lookup failed — proceeding without dedup', {
        error: (err as Error).message,
      });
    }
    const newProducts = products.filter((p) => !alreadyProcessed.has(p.id));
    if (newProducts.length === 0) {
      ingestionLogger.info('EUMETSAT: all products already processed');
      return;
    }

    ingestionLogger.info({ count: newProducts.length }, 'EUMETSAT new products to process');

    // 3. Process each new product. Dedup happens via ingestion_log (above)
    // and is finalised by the INSERT below — every code path that reaches
    // the catch or the download-failed continue still writes a row so the
    // product is recorded as "seen" and won't be re-attempted next cycle.
    // qc_status records the outcome so ops can distinguish a quiet feed
    // (LOW_COUNT) from a real error (ERROR / DOWNLOAD_FAILED).
    const recordSeen = async (
      product: ProductInfo,
      flashCount: number,
      qcStatus: string,
    ): Promise<void> => {
      try {
        await query(
          `INSERT INTO ingestion_log (
            product_id, product_time_start, product_time_end,
            flash_count, ingested_at, qc_status
          ) VALUES ($1, $2, $3, $4, NOW(), $5)
          ON CONFLICT DO NOTHING`,
          [
            product.id,
            product.sensing_start || DateTime.utc().toISO()!,
            product.sensing_end || DateTime.utc().toISO()!,
            flashCount,
            qcStatus,
          ],
        );
      } catch (logErr) {
        ingestionLogger.warn('EUMETSAT failed to record ingestion_log row', {
          productId: product.id,
          qcStatus,
          error: (logErr as Error).message,
        });
      }
    };

    for (const product of newProducts) {
      try {
        const ncPath = await downloadProduct(product.id);
        if (!ncPath) {
          ingestionLogger.warn({ productId: product.id }, 'EUMETSAT skipping: download failed');
          await recordSeen(product, 0, 'DOWNLOAD_FAILED');
          continue;
        }

        const flashes = await parseNetCDF(ncPath);
        ingestionLogger.info(
          { count: flashes.length, productTitle: product.title },
          'EUMETSAT parsed flashes',
        );

        const { total, ingested } = await ingestFlashes(flashes, product.id);

        await recordSeen(product, ingested, ingested > 0 ? 'OK' : 'LOW_COUNT');

        ingestionLogger.info(
          { ingested, total, productId: product.id, productTitle: product.title },
          'EUMETSAT ingested flashes (Southern Africa)',
        );

        try {
          fs.unlinkSync(ncPath);
        } catch {
          /* ignore cleanup errors */
        }
      } catch (err) {
        ingestionLogger.error(
          { productId: product.id, error: (err as Error).message },
          'EUMETSAT error processing product',
        );
        await recordSeen(product, 0, 'ERROR');
      }
    }

    ingestionLogger.info('EUMETSAT ingestion cycle complete');
  } catch (err) {
    ingestionLogger.error({ error: (err as Error).message }, 'EUMETSAT ingestion cycle error');
  } finally {
    isIngesting = false;
  }
}

// ============================================================
// AFA ingestion cycle
// ============================================================

async function runAfaIngestionCycle(): Promise<void> {
  if (isIngesting) {
    ingestionLogger.warn('AFA: previous ingestion still running, skipping');
    return;
  }
  isIngesting = true;
  await writeHeartbeat('api_ingester_last_attempt_at');

  try {
    const previousCollection = process.env.EUMETSAT_COLLECTION_ID;
    process.env.EUMETSAT_COLLECTION_ID = process.env.EUMETSAT_AFA_COLLECTION_ID || 'EO:EUM:DAT:0687';

    try {
      const products = await searchProducts(60);
      ingestionLogger.info({ count: products.length }, 'AFA product search');
      await writeHeartbeat('api_ingester_last_success_at');
      if (products.length === 0) return;

      let alreadyProcessed = new Set<string>();
      try {
        const productIds = products.map((p) => p.id);
        const { rows } = await query(
          `SELECT product_id FROM ingestion_log WHERE product_id = ANY($1)`,
          [productIds],
        );
        alreadyProcessed = new Set(rows.map((r) => r.product_id as string));
      } catch (err) {
        ingestionLogger.warn('AFA dedup lookup failed', { error: (err as Error).message });
      }
      const newProducts = products.filter((p) => !alreadyProcessed.has(p.id));
      if (newProducts.length === 0) return;

      ingestionLogger.info({ count: newProducts.length }, 'AFA new products');

      const recordSeen = async (
        product: ProductInfo,
        pixelCount: number,
        qcStatus: string,
      ): Promise<void> => {
        try {
          await query(
            `INSERT INTO ingestion_log (
              product_id, product_time_start, product_time_end,
              flash_count, ingested_at, qc_status
            ) VALUES ($1, $2, $3, $4, NOW(), $5)
            ON CONFLICT DO NOTHING`,
            [
              product.id,
              product.sensing_start || new Date().toISOString(),
              product.sensing_end || new Date().toISOString(),
              pixelCount,
              qcStatus,
            ],
          );
        } catch (logErr) {
          ingestionLogger.warn('AFA failed to record ingestion_log row', {
            productId: product.id,
            qcStatus,
            error: (logErr as Error).message,
          });
        }
      };

      for (const product of newProducts) {
        try {
          const ncPath = await downloadProduct(product.id);
          if (!ncPath) {
            ingestionLogger.warn({ productId: product.id }, 'AFA skipping: download failed');
            await recordSeen(product, 0, 'DOWNLOAD_FAILED');
            continue;
          }
          const pixels = await parseAfaNetCDF(ncPath);
          const { total, ingested } = await ingestAfaPixels(pixels, product.id);
          await recordSeen(product, ingested, ingested > 0 ? 'OK' : 'LOW_COUNT');
          ingestionLogger.info({ ingested, total, productId: product.id }, 'AFA ingested pixels');
          try { fs.unlinkSync(ncPath); } catch { /* ignore */ }
        } catch (err) {
          ingestionLogger.error({ productId: product.id, error: (err as Error).message }, 'AFA error');
          await recordSeen(product, 0, 'ERROR');
        }
      }

      ingestionLogger.info('AFA ingestion cycle complete');
    } finally {
      if (previousCollection === undefined) delete process.env.EUMETSAT_COLLECTION_ID;
      else process.env.EUMETSAT_COLLECTION_ID = previousCollection;
    }
  } catch (err) {
    ingestionLogger.error({ error: (err as Error).message }, 'AFA cycle error');
  } finally {
    isIngesting = false;
  }
}

// ============================================================
// Public API
// ============================================================

/**
 * Probe the local Python toolchain. Live ingestion shells out to
 * `parse_nc_json.py` to read the netCDF product, so missing python or
 * missing netCDF4 means we'd accept credentials, fail every product fetch
 * with a vague spawn error, and silently fall back to mock data —
 * exactly the failure mode flagged in the 2026-05-02 audit.
 *
 * Returns { ok: true } when both are present; { ok: false, error } when
 * the binary is missing or the import fails.
 */
async function probePythonNetcdf(): Promise<{ ok: boolean; error?: string }> {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  return await new Promise((resolve) => {
    let stderr = '';
    let stdout = '';
    let proc;
    try {
      proc = spawn(python, ['-c', 'import netCDF4, sys; print(netCDF4.__version__)']);
    } catch (err) {
      resolve({ ok: false, error: `spawn failed: ${(err as Error).message}` });
      return;
    }
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.on('error', (err) => {
      resolve({ ok: false, error: `spawn failed: ${err.message}` });
    });
    const killTimer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }, 8000);
    proc.on('close', (code) => {
      clearTimeout(killTimer);
      if (code === 0) {
        ingestionLogger.info({ netCDF4Version: stdout.trim() }, 'Python netCDF4 probe passed');
        resolve({ ok: true });
      } else {
        resolve({
          ok: false,
          error: stderr.trim().slice(-400) || `python exited with code ${code}`,
        });
      }
    });
  });
}

export async function startLiveIngestion(intervalSec: number = 120): Promise<boolean> {
  if (!hasCredentials()) {
    ingestionLogger.info('EUMETSAT: no credentials configured — live ingestion disabled');
    return false;
  }

  // Probe Python BEFORE we accept the live-mode boot. Without this, a
  // missing python/netCDF4 surfaces only when the first product comes back
  // and the parser fails — by which point /api/health reports
  // mode: 'live-eumetsat' but every flash query is empty.
  const pyProbe = await probePythonNetcdf();
  if (!pyProbe.ok) {
    ingestionLogger.error(
      { error: pyProbe.error },
      'EUMETSAT: Python/netCDF4 probe failed — refusing live ingestion. Install Python 3 and `pip install netCDF4` (or set EUMETSAT credentials to empty for mock mode).',
    );
    return false;
  }

  // Verify credentials by getting a token
  try {
    await getAccessToken();
    ingestionLogger.info('EUMETSAT credentials verified — starting live ingestion');
  } catch (err) {
    ingestionLogger.error(
      { error: (err as Error).message },
      'EUMETSAT credential verification failed — falling back to mock simulation',
    );
    return false;
  }

  ingestionStopped = false;

  const source = (process.env.LIGHTNING_SOURCE || 'lfl').toLowerCase();
  const cycleFn = source === 'afa' ? runAfaIngestionCycle : runIngestionCycle;

  // Chained setTimeout — matches the risk engine's scheduler. With
  // setInterval, an ingestion cycle that ran longer than the configured
  // interval would re-fire while the previous one was still in flight; the
  // `isIngesting` guard turned that into a no-op but the no-ops bunched
  // future cycles against the wall clock. Chaining means each cycle starts
  // `intervalSec` AFTER the previous one finishes, so an 130s cycle on a
  // 120s interval still produces orderly 130s+120s gaps instead of bunched
  // ticks against an unmoving wall.
  const scheduleNext = () => {
    if (ingestionStopped) return;
    ingestionTimer = setTimeout(async () => {
      ingestionTimer = null;
      try {
        await cycleFn();
      } catch (err) {
        ingestionLogger.error(
          { error: (err as Error).message },
          'EUMETSAT scheduled ingestion error',
        );
      } finally {
        scheduleNext();
      }
    }, intervalSec * 1000);
  };

  // Run first cycle immediately, then chain.
  void (async () => {
    try {
      await cycleFn();
    } catch (err) {
      ingestionLogger.error(
        { error: (err as Error).message },
        'EUMETSAT initial ingestion cycle error',
      );
    } finally {
      scheduleNext();
    }
  })();

  ingestionLogger.info({ intervalSec, source }, 'EUMETSAT live ingestion started');
  return true;
}

export function stopLiveIngestion(): void {
  ingestionStopped = true;
  if (ingestionTimer) {
    clearTimeout(ingestionTimer);
    ingestionTimer = null;
    ingestionLogger.info('EUMETSAT live ingestion stopped');
  }
}

export { runIngestionCycle, runAfaIngestionCycle };

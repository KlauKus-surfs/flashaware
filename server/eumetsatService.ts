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
const processedProducts = new Set<string>();
let ingestionInterval: ReturnType<typeof setInterval> | null = null;
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

  const data = await resp.json() as any;
  cachedToken = {
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
  };

  console.log('[EUMETSAT] Access token acquired');
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

  const data = await resp.json() as any;

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

  console.log(`[EUMETSAT] Downloading product: ${productId}`);
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    console.error(`[EUMETSAT] Download failed (${resp.status}) for ${productId}`);
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
      (e) => e.entryName.includes('CHK-BODY') && e.entryName.endsWith('.nc')
    );

    if (bodyEntry) {
      const outPath = path.join(DATA_DIR, path.basename(bodyEntry.entryName));
      zip.extractEntryTo(bodyEntry, DATA_DIR, false, true);
      console.log(`[EUMETSAT] Extracted BODY: ${path.basename(bodyEntry.entryName)}`);
      return outPath;
    }

    // If no BODY file, look for any .nc file
    const ncEntry = entries.find((e) => e.entryName.endsWith('.nc'));
    if (ncEntry) {
      const outPath = path.join(DATA_DIR, path.basename(ncEntry.entryName));
      zip.extractEntryTo(ncEntry, DATA_DIR, false, true);
      console.log(`[EUMETSAT] Extracted NC: ${path.basename(ncEntry.entryName)}`);
      return outPath;
    }

    console.warn(`[EUMETSAT] No .nc files found in ZIP for ${productId}`);
    return null;
  } catch {
    // Not a ZIP — might be a raw NetCDF file
    const outPath = path.join(DATA_DIR, `${productId.replace(/[^a-zA-Z0-9_-]/g, '_')}.nc`);
    fs.writeFileSync(outPath, buffer);
    console.log(`[EUMETSAT] Saved raw file: ${path.basename(outPath)}`);
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
    const proc = spawn(python, [PARSER_SCRIPT, ncPath], {
      timeout: 60_000,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
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
      reject(new Error(`Failed to spawn Python: ${err.message}. Ensure Python and netCDF4 are installed.`));
    });
  });
}

// ============================================================
// Ingest flashes into PostgreSQL
// ============================================================

// Southern Africa bounding box (generous buffer for approaching storms)
const SA_BBOX = { south: -36.0, north: -18.0, west: 14.0, east: 38.0 };

function isInSouthernAfrica(lat: number, lng: number): boolean {
  return lat >= SA_BBOX.south && lat <= SA_BBOX.north &&
         lng >= SA_BBOX.west && lng <= SA_BBOX.east;
}

async function ingestFlashes(flashes: ParsedFlash[], productId: string): Promise<{ total: number; ingested: number }> {
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
        ]
      );
      ingested++;
    } catch (err) {
      ingestionLogger.warn('Failed to insert flash', { flashId: f.flash_id, error: (err as Error).message });
    }
  }

  return { total: flashes.length, ingested };
}

// ============================================================
// Full ingestion cycle
// ============================================================

async function runIngestionCycle(): Promise<void> {
  if (isIngesting) {
    console.warn('[EUMETSAT] Previous ingestion still running, skipping');
    return;
  }
  isIngesting = true;

  try {
    console.log(`[EUMETSAT] Starting ingestion cycle at ${DateTime.utc().toISO()}`);

    // 1. Search for recent products
    const products = await searchProducts(60);
    console.log(`[EUMETSAT] Found ${products.length} product(s) in last 60 min`);

    if (products.length === 0) {
      return;
    }

    // 2. Filter already-processed products
    const newProducts = products.filter((p) => !processedProducts.has(p.id));
    if (newProducts.length === 0) {
      console.log('[EUMETSAT] All products already processed');
      return;
    }

    console.log(`[EUMETSAT] ${newProducts.length} new product(s) to process`);

    // 3. Process each new product
    for (const product of newProducts) {
      try {
        // Download
        const ncPath = await downloadProduct(product.id);
        if (!ncPath) {
          console.warn(`[EUMETSAT] Skipping ${product.id}: download failed`);
          processedProducts.add(product.id); // Don't retry failed downloads
          continue;
        }

        // Parse NetCDF
        const flashes = await parseNetCDF(ncPath);
        console.log(`[EUMETSAT] Parsed ${flashes.length} flashes from ${product.title}`);

        // Ingest into PostgreSQL (filtered to Southern Africa)
        const { total, ingested } = await ingestFlashes(flashes, product.id);

        // Log ingestion to DB
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
            ingested,
            ingested > 0 ? 'OK' : 'LOW_COUNT',
          ]
        );

        // Mark as processed
        processedProducts.add(product.id);
        ingestionLogger.info(`Ingested ${ingested}/${total} flashes (Southern Africa)`, { productId: product.id });
        console.log(`[EUMETSAT] ✅ Ingested ${ingested}/${total} flashes (Southern Africa) from ${product.title}`);

        // Clean up downloaded file
        try {
          fs.unlinkSync(ncPath);
        } catch {
          // Ignore cleanup errors
        }
      } catch (err) {
        console.error(`[EUMETSAT] Error processing ${product.id}:`, err);
        processedProducts.add(product.id); // Don't retry on error
      }
    }

    // 4. Prune processed products set (keep last 200 in memory)
    if (processedProducts.size > 200) {
      const arr = Array.from(processedProducts);
      processedProducts.clear();
      arr.slice(-100).forEach((id) => processedProducts.add(id));
    }

    ingestionLogger.info('Ingestion cycle complete');
    console.log('[EUMETSAT] Ingestion cycle complete');
  } catch (err) {
    console.error('[EUMETSAT] Ingestion cycle error:', err);
  } finally {
    isIngesting = false;
  }
}

// ============================================================
// Public API
// ============================================================

export async function startLiveIngestion(intervalSec: number = 120): Promise<boolean> {
  if (!hasCredentials()) {
    console.log('[EUMETSAT] No credentials configured — live ingestion disabled');
    return false;
  }

  // Verify credentials by getting a token
  try {
    await getAccessToken();
    console.log('[EUMETSAT] ✅ Credentials verified — starting live ingestion');
  } catch (err) {
    console.error('[EUMETSAT] ❌ Credential verification failed:', (err as Error).message);
    console.log('[EUMETSAT] Falling back to mock simulation');
    return false;
  }

  // Run first cycle immediately
  await runIngestionCycle();

  // Schedule periodic ingestion
  ingestionInterval = setInterval(() => {
    runIngestionCycle().catch((err) =>
      console.error('[EUMETSAT] Scheduled ingestion error:', err)
    );
  }, intervalSec * 1000);

  console.log(`[EUMETSAT] Live ingestion started (interval: ${intervalSec}s)`);
  return true;
}

export function stopLiveIngestion(): void {
  if (ingestionInterval) {
    clearInterval(ingestionInterval);
    ingestionInterval = null;
    console.log('[EUMETSAT] Live ingestion stopped');
  }
}

export { runIngestionCycle };

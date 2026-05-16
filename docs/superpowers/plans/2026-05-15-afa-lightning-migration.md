# AFA Lightning Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace LI-2-LFL centroid-point lightning ingestion with LI-2-AFA 2 km grid-pixel ingestion, with a dual-threshold (lit pixels + incidence) risk engine and a four-layer map UI.

**Architecture:** New `afa_pixels` table backed by AFA half-minute products (`EO:EUM:DAT:0687`). Feature-flag `LIGHTNING_SOURCE` dispatches the ingester and risk-engine query helpers; both LFL and AFA code paths coexist for a 7-day grace window before LFL is decommissioned. Polygons stored sparsely, queried at runtime with the existing PostGIS spatial index.

**Tech Stack:** Node 20 + TypeScript + Express + Socket.IO, Python 3.11 + netCDF4, PostgreSQL 16 + PostGIS 3.4, React 18 + Leaflet (+ leaflet.heat plugin), Vitest.

**Reference spec:** [docs/superpowers/specs/2026-05-15-afa-lightning-migration-design.md](../specs/2026-05-15-afa-lightning-migration-design.md)

---

## Pre-work — environment

- [ ] **Step 0.1: Add `leaflet.heat` to client deps**

```bash
cd client && npm install leaflet.heat@^0.2.0 && npm install --save-dev @types/leaflet.heat
```

- [ ] **Step 0.2: Add `LIGHTNING_SOURCE` to `.env.example`**

In [.env.example](../../.env.example), add under the EUMETSAT block:

```
# Active lightning data source. 'lfl' (legacy LI-2-LFL points) or 'afa'
# (LI-2-AFA 2 km grid pixels). Default 'lfl' until cutover.
LIGHTNING_SOURCE=lfl

# AFA-specific collection id (only used when LIGHTNING_SOURCE=afa)
EUMETSAT_AFA_COLLECTION_ID=EO:EUM:DAT:0687
```

- [ ] **Step 0.3: Commit env scaffolding**

```bash
git add .env.example client/package.json client/package-lock.json
git commit -m "chore(afa): scaffold LIGHTNING_SOURCE env flag and leaflet.heat dep"
```

---

## Task 1: Schema migration — `afa_pixels` table + threshold columns

**Files:**
- Modify: `server/migrate.ts` (append a new `runOnce` block)
- Modify: `db/schema.sql` (mirror for fresh-DB consistency)

- [ ] **Step 1.1: Append the migration in `server/migrate.ts`**

Locate the line `void runOnce;` (currently around line 63) and remove the void-reference. Below the existing `flash_events` block, add:

```ts
await runOnce('20260515-afa-pixels', async () => {
  await query(`
    CREATE TABLE IF NOT EXISTS afa_pixels (
      id              BIGSERIAL PRIMARY KEY,
      product_id      TEXT NOT NULL,
      observed_at_utc TIMESTAMPTZ NOT NULL,
      pixel_lat       REAL NOT NULL,
      pixel_lon       REAL NOT NULL,
      geom            GEOMETRY(POLYGON, 4326) NOT NULL,
      flash_count     INTEGER NOT NULL CHECK (flash_count > 0)
    )
  `);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_afa_pixel
      ON afa_pixels (product_id, pixel_lat, pixel_lon)
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_afa_pixels_time ON afa_pixels (observed_at_utc)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_afa_pixels_geom ON afa_pixels USING GIST (geom)`);
});

await runOnce('20260515-location-afa-thresholds', async () => {
  await query(`
    ALTER TABLE locations
      ADD COLUMN IF NOT EXISTS stop_lit_pixels    INTEGER NOT NULL DEFAULT 1
        CHECK (stop_lit_pixels >= 1),
      ADD COLUMN IF NOT EXISTS stop_incidence     INTEGER NOT NULL DEFAULT 5
        CHECK (stop_incidence >= 1),
      ADD COLUMN IF NOT EXISTS prepare_lit_pixels INTEGER NOT NULL DEFAULT 1
        CHECK (prepare_lit_pixels >= 1),
      ADD COLUMN IF NOT EXISTS prepare_incidence  INTEGER NOT NULL DEFAULT 1
        CHECK (prepare_incidence >= 1)
  `);
});
```

- [ ] **Step 1.2: Mirror the schema in `db/schema.sql`**

In [db/schema.sql](../../db/schema.sql), after the `flash_events` CREATE TABLE block, append:

```sql
CREATE TABLE IF NOT EXISTS afa_pixels (
    id              BIGSERIAL PRIMARY KEY,
    product_id      TEXT NOT NULL,
    observed_at_utc TIMESTAMPTZ NOT NULL,
    pixel_lat       REAL NOT NULL,
    pixel_lon       REAL NOT NULL,
    geom            GEOMETRY(POLYGON, 4326) NOT NULL,
    flash_count     INTEGER NOT NULL CHECK (flash_count > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_afa_pixel ON afa_pixels (product_id, pixel_lat, pixel_lon);
CREATE INDEX IF NOT EXISTS idx_afa_pixels_time ON afa_pixels (observed_at_utc);
CREATE INDEX IF NOT EXISTS idx_afa_pixels_geom ON afa_pixels USING GIST (geom);
```

In the `locations` table block, add the four columns alongside the existing thresholds:

```sql
stop_lit_pixels         INTEGER NOT NULL DEFAULT 1  CHECK (stop_lit_pixels >= 1),
stop_incidence          INTEGER NOT NULL DEFAULT 5  CHECK (stop_incidence >= 1),
prepare_lit_pixels      INTEGER NOT NULL DEFAULT 1  CHECK (prepare_lit_pixels >= 1),
prepare_incidence       INTEGER NOT NULL DEFAULT 1  CHECK (prepare_incidence >= 1),
```

- [ ] **Step 1.3: Run migration locally and verify**

```bash
docker compose up -d
cd server && npm run dev &
# Wait 10s for migrations to run
psql -h localhost -U postgres -d flashaware -c "\d afa_pixels"
psql -h localhost -U postgres -d flashaware -c "\d locations" | grep -E "lit_pixels|incidence"
```

Expected: table `afa_pixels` exists with all columns; `locations` shows the four new columns with the correct defaults.

- [ ] **Step 1.4: Extend `runRetention` to sweep `afa_pixels`**

In [server/index.ts](../../server/index.ts), find the `runRetention` function (search for `DELETE FROM flash_events`). Alongside the existing `flash_events` delete, add:

```ts
await query(
  `DELETE FROM afa_pixels WHERE observed_at_utc < NOW() - ($1 || ' days')::interval`,
  [process.env.DATA_RETENTION_DAYS || '30'],
);
```

- [ ] **Step 1.5: Commit**

```bash
git add server/migrate.ts db/schema.sql server/index.ts
git commit -m "feat(afa): add afa_pixels table, dual-threshold columns, retention sweep"
```

---

## Task 2: Python AFA parser — discover and parse netCDF

**Files:**
- Create: `ingestion/parse_afa_nc_json.py`
- Create: `ingestion/tests/test_parse_afa.py`
- Create: `ingestion/tests/fixtures/make_afa_fixture.py` (one-shot fixture generator)

- [ ] **Step 2.1: Discover the real AFA file structure**

Download one live product to learn variable names and grid layout.

```bash
cd ingestion
python -c "
import os, sys, requests, zipfile, io
from base64 import b64encode

key = os.environ['EUMETSAT_CONSUMER_KEY']
sec = os.environ['EUMETSAT_CONSUMER_SECRET']
auth = b64encode(f'{key}:{sec}'.encode()).decode()
tok = requests.post('https://api.eumetsat.int/token',
    headers={'Authorization': f'Basic {auth}', 'Content-Type':'application/x-www-form-urlencoded'},
    data='grant_type=client_credentials').json()['access_token']

r = requests.get('https://api.eumetsat.int/data/search-products/1.0.0/os',
    headers={'Authorization': f'Bearer {tok}'},
    params={'pi':'EO:EUM:DAT:0687','c':'1','format':'json','sort':'start,time,1'})
pid = r.json()['features'][0]['id']
print('product:', pid)

dl = requests.get(f'https://api.eumetsat.int/data/download/1.0.0/collections/{requests.utils.quote(\"EO:EUM:DAT:0687\",safe=\"\")}/products/{requests.utils.quote(pid,safe=\"\")}',
    headers={'Authorization': f'Bearer {tok}'})
with open('/tmp/afa_sample.zip','wb') as f: f.write(dl.content)
print('size:', len(dl.content))
"

# Inspect contents
unzip -l /tmp/afa_sample.zip
unzip -o /tmp/afa_sample.zip -d /tmp/afa_sample/

# Print netCDF variable names and shapes
python -c "
import netCDF4 as nc, glob
for p in glob.glob('/tmp/afa_sample/**/*.nc', recursive=True):
    print('===', p)
    ds = nc.Dataset(p)
    print('dims:', dict(ds.dimensions))
    for v in ds.variables:
        var = ds.variables[v]
        print(f'  {v}: shape={var.shape} dtype={var.dtype} attrs={dict(var.__dict__)}')
    ds.close()
"
```

Record the variable names (likely `accumulated_flash_area`, `latitude`, `longitude`, and a time variable) in a comment at the top of `parse_afa_nc_json.py` for future reference.

- [ ] **Step 2.2: Create the fixture generator**

Create `ingestion/tests/fixtures/make_afa_fixture.py`:

```python
"""
Generate a synthetic AFA netCDF for parser unit tests. Run once; checks in
ingestion/tests/fixtures/afa_sample.nc.

Mirrors the variable names and dimensions observed in the real LI-2-AFA
product (see comment block in parse_afa_nc_json.py for the spec inspection
that informed these).
"""
import netCDF4 as nc
import numpy as np
import os

OUT = os.path.join(os.path.dirname(__file__), 'afa_sample.nc')

# 5x5 grid centred on Johannesburg with a single 'lit' 3x3 block
lats = np.linspace(-26.30, -26.10, 5).astype(np.float32)
lons = np.linspace(27.95, 28.15, 5).astype(np.float32)
afa = np.zeros((5, 5), dtype=np.int32)
afa[1:4, 1:4] = [[1, 2, 1],
                 [2, 5, 2],
                 [1, 2, 1]]

ds = nc.Dataset(OUT, 'w', format='NETCDF4')
ds.createDimension('y', 5)
ds.createDimension('x', 5)
ds.createDimension('time', 1)

v_lat = ds.createVariable('latitude', 'f4', ('y',))
v_lon = ds.createVariable('longitude', 'f4', ('x',))
v_afa = ds.createVariable('accumulated_flash_area', 'i4', ('y', 'x'))
v_afa.units = 'count'
v_time = ds.createVariable('time', 'f8', ('time',))
v_time.units = 'seconds since 1970-01-01 00:00:00'
v_time.calendar = 'standard'

v_lat[:] = lats
v_lon[:] = lons
v_afa[:] = afa
v_time[:] = [1747318470.0]  # 2025-05-15T12:34:30Z

ds.close()
print('wrote', OUT)
```

Run it once:

```bash
cd ingestion && python tests/fixtures/make_afa_fixture.py
```

If the real AFA file uses different variable names (e.g., not `accumulated_flash_area`), edit this script to match the real names AND update the parser in Step 2.4 to match. The fixture must be structurally identical to the real product.

- [ ] **Step 2.3: Write the failing parser test**

Create `ingestion/tests/test_parse_afa.py`:

```python
import json
import subprocess
import os
import sys

THIS_DIR = os.path.dirname(__file__)
PARSER = os.path.join(THIS_DIR, '..', 'parse_afa_nc_json.py')
FIXTURE = os.path.join(THIS_DIR, 'fixtures', 'afa_sample.nc')


def run_parser():
    proc = subprocess.run(
        [sys.executable, PARSER, FIXTURE],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(proc.stdout)


def test_extracts_only_nonzero_pixels():
    rows = run_parser()
    # 3x3 lit block = 9 pixels with flash_count > 0
    assert len(rows) == 9


def test_pixel_shape():
    rows = run_parser()
    sample = rows[0]
    assert set(sample.keys()) == {
        'observed_at_utc', 'pixel_lat', 'pixel_lon', 'flash_count', 'geom_wkt'
    }
    assert sample['flash_count'] >= 1
    assert sample['geom_wkt'].startswith('POLYGON((')


def test_centre_pixel_has_highest_count():
    rows = run_parser()
    counts = sorted([r['flash_count'] for r in rows])
    # Distribution from fixture: 1,1,1,1,2,2,2,2,5
    assert counts == [1, 1, 1, 1, 2, 2, 2, 2, 5]


def test_observed_at_is_iso8601_utc():
    rows = run_parser()
    assert rows[0]['observed_at_utc'].endswith('Z') or '+00:00' in rows[0]['observed_at_utc']
```

Run: `cd ingestion && python -m pytest tests/test_parse_afa.py -v`
Expected: FAIL — parser doesn't exist yet.

- [ ] **Step 2.4: Implement the parser**

Create `ingestion/parse_afa_nc_json.py`:

```python
#!/usr/bin/env python3
"""
NetCDF -> JSON parser for LI-2-AFA (Accumulated Flash Area).
Outputs JSON array of one object per non-zero 2 km pixel to stdout.

Variable names below were verified against a real EO:EUM:DAT:0687 product
on 2026-05-15. Update both this file AND tests/fixtures/make_afa_fixture.py
together if EUMETSAT changes the format.

Usage: python parse_afa_nc_json.py <body.nc>
"""

import sys
import json
import numpy as np

# Southern Africa bounding box — match the API ingester's clip
SA = {'south': -36.0, 'north': -18.0, 'west': 14.0, 'east': 38.0}

# 2 km pixel half-extent in degrees. Lat is ~constant; lon scales by cos(lat).
LAT_HALF = 1.0 / 111.0  # ~0.009 deg = ~1 km, so half a 2 km cell is 0.009
# Note: AFA pixels are 2 km on a side. Half-extent for polygon corners is 1 km
# in each direction, which we approximate as the values above. The polygon is
# a small rectangle, so this approximation is well within the spatial accuracy
# the data itself provides.


def cell_polygon_wkt(lat: float, lon: float) -> str:
    lat_h = LAT_HALF
    lon_h = LAT_HALF / max(np.cos(np.radians(lat)), 0.1)
    s, n = lat - lat_h, lat + lat_h
    w, e = lon - lon_h, lon + lon_h
    return f"POLYGON(({w} {s}, {e} {s}, {e} {n}, {w} {n}, {w} {s}))"


def parse(filepath: str) -> None:
    try:
        import netCDF4 as nc
    except ImportError:
        print(json.dumps({"error": "netCDF4 not installed"}), file=sys.stderr)
        sys.exit(1)

    try:
        ds = nc.Dataset(filepath, "r")
    except Exception as e:
        print(json.dumps({"error": f"Failed to open {filepath}: {e}"}), file=sys.stderr)
        sys.exit(1)

    try:
        afa = ds.variables["accumulated_flash_area"][:]
        lats = ds.variables["latitude"][:]
        lons = ds.variables["longitude"][:]

        time_var = ds.variables["time"]
        time_val = nc.num2date(
            time_var[:][0],
            units=time_var.units,
            calendar=getattr(time_var, "calendar", "standard"),
        )
        observed_at = time_val.isoformat() + "Z" if not time_val.isoformat().endswith("Z") else time_val.isoformat()

        ds.close()

        rows = []
        # afa shape is (y, x) per inspection. If the real product uses a flat
        # feature list instead, this branch must be rewritten — see header comment.
        for yi in range(afa.shape[0]):
            for xi in range(afa.shape[1]):
                count = int(afa[yi, xi])
                if count <= 0:
                    continue
                lat = float(lats[yi])
                lon = float(lons[xi])
                if not (SA["south"] <= lat <= SA["north"] and SA["west"] <= lon <= SA["east"]):
                    continue
                rows.append({
                    "observed_at_utc": observed_at,
                    "pixel_lat": round(lat, 5),
                    "pixel_lon": round(lon, 5),
                    "flash_count": count,
                    "geom_wkt": cell_polygon_wkt(lat, lon),
                })

        json.dump(rows, sys.stdout)
    except Exception as e:
        try:
            ds.close()
        except Exception:
            pass
        print(json.dumps({"error": f"Parse error: {e}"}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python parse_afa_nc_json.py <body.nc>", file=sys.stderr)
        sys.exit(1)
    parse(sys.argv[1])
```

If the variable inspection in Step 2.1 revealed names other than `accumulated_flash_area`, `latitude`, `longitude`, `time`, edit this file accordingly. The test fixture in Step 2.2 must use matching names.

- [ ] **Step 2.5: Run tests until they pass**

```bash
cd ingestion && python -m pytest tests/test_parse_afa.py -v
```

Expected: 4 passed.

- [ ] **Step 2.6: Commit**

```bash
git add ingestion/parse_afa_nc_json.py ingestion/tests/
git commit -m "feat(afa): netCDF parser for LI-2-AFA grid pixels with synthetic fixture"
```

---

## Task 3: AFA live ingester + feature-flag dispatch

**Files:**
- Modify: `server/eumetsatService.ts`

- [ ] **Step 3.1: Add AFA-specific helpers above the existing `runIngestionCycle`**

In [server/eumetsatService.ts](../../server/eumetsatService.ts), add after the `ParsedFlash` interface and `parseNetCDF` function:

```ts
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
```

- [ ] **Step 3.2: Add the AFA cycle alongside the LFL cycle**

Below `runIngestionCycle` (the LFL one), add:

```ts
async function runAfaIngestionCycle(): Promise<void> {
  if (isIngesting) {
    ingestionLogger.warn('AFA: previous ingestion still running, skipping');
    return;
  }
  isIngesting = true;
  await writeHeartbeat('api_ingester_last_attempt_at');

  try {
    // Reuse searchProducts but override the collection id via env.
    // searchProducts already reads EUMETSAT_COLLECTION_ID — temporarily swap.
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

      for (const product of newProducts) {
        try {
          const ncPath = await downloadProduct(product.id);
          if (!ncPath) {
            await query(
              `INSERT INTO ingestion_log (product_id, product_time_start, product_time_end, flash_count, ingested_at, qc_status)
               VALUES ($1,$2,$3,0,NOW(),'DOWNLOAD_FAILED') ON CONFLICT DO NOTHING`,
              [product.id, product.sensing_start || new Date().toISOString(), product.sensing_end || new Date().toISOString()],
            );
            continue;
          }
          const pixels = await parseAfaNetCDF(ncPath);
          const { total, ingested } = await ingestAfaPixels(pixels, product.id);
          await query(
            `INSERT INTO ingestion_log (product_id, product_time_start, product_time_end, flash_count, ingested_at, qc_status)
             VALUES ($1,$2,$3,$4,NOW(),$5) ON CONFLICT DO NOTHING`,
            [product.id, product.sensing_start || new Date().toISOString(),
             product.sensing_end || new Date().toISOString(), ingested,
             ingested > 0 ? 'OK' : 'LOW_COUNT'],
          );
          ingestionLogger.info({ ingested, total, productId: product.id }, 'AFA ingested pixels');
          try { fs.unlinkSync(ncPath); } catch { /* ignore */ }
        } catch (err) {
          ingestionLogger.error({ productId: product.id, error: (err as Error).message }, 'AFA error');
          await query(
            `INSERT INTO ingestion_log (product_id, product_time_start, product_time_end, flash_count, ingested_at, qc_status)
             VALUES ($1,$2,$3,0,NOW(),'ERROR') ON CONFLICT DO NOTHING`,
            [product.id, product.sensing_start || new Date().toISOString(),
             product.sensing_end || new Date().toISOString()],
          );
        }
      }
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
```

- [ ] **Step 3.3: Dispatch on the feature flag in `startLiveIngestion`**

Locate the chained `setTimeout` block inside `startLiveIngestion`. Replace `runIngestionCycle()` (called twice — initial run and chained) with:

```ts
const source = (process.env.LIGHTNING_SOURCE || 'lfl').toLowerCase();
const cycleFn = source === 'afa' ? runAfaIngestionCycle : runIngestionCycle;
```

Then replace both occurrences of `await runIngestionCycle()` inside the function with `await cycleFn()`.

Update the export at the bottom:

```ts
export { runIngestionCycle, runAfaIngestionCycle };
```

- [ ] **Step 3.4: Smoke test the AFA ingester locally**

```bash
# In .env, set:
# LIGHTNING_SOURCE=afa
# EUMETSAT_AFA_COLLECTION_ID=EO:EUM:DAT:0687
# (keep your real EUMETSAT_CONSUMER_KEY/SECRET)
cd server && npm run dev
# Watch the log for "AFA product search count=N" and "AFA ingested pixels"
# After ~3 minutes:
psql -h localhost -U postgres -d flashaware -c "SELECT COUNT(*), MIN(observed_at_utc), MAX(observed_at_utc) FROM afa_pixels"
```

Expected: row count > 0 (assuming any storm activity over Southern Africa), times within the last hour.

If `COUNT(*)` is 0 after 5 min, check the parser script for variable-name mismatches against the real product (see Step 2.1).

- [ ] **Step 3.5: Commit**

```bash
git add server/eumetsatService.ts
git commit -m "feat(afa): live ingester for LI-2-AFA, dispatched by LIGHTNING_SOURCE"
```

---

## Task 4: AFA query helpers in `server/db.ts`

**Files:**
- Modify: `server/db.ts` (add three functions next to the existing `countFlashesInRadius` etc.)
- Modify: `server/queries.ts` (re-export from barrel)

- [ ] **Step 4.1: Add the three helpers in `server/db.ts`**

After `getRecentFlashes`, append:

```ts
export async function countLitPixelsAndIncidence(
  centroidWkt: string,
  radiusKm: number,
  windowMinutes: number,
  now?: Date,
): Promise<{ litPixels: number; incidence: number }> {
  const sql = withNow(
    now,
    `SELECT COUNT(*) AS lit, COALESCE(SUM(flash_count), 0) AS inc
       FROM afa_pixels
      WHERE ST_DWithin(geom::geography, ST_GeomFromText(${shift(now, 1)}, 4326)::geography, ${shift(now, 2)})
        AND observed_at_utc >= $NOW$ - (${shift(now, 3)} || ' minutes')::interval`,
  );
  const r = await query(sql, nowParams(now, [centroidWkt, radiusKm * 1000, windowMinutes.toString()]));
  return {
    litPixels: parseInt(r.rows[0].lit, 10),
    incidence: parseInt(r.rows[0].inc, 10),
  };
}

export async function nearestLitPixelKm(
  centroidWkt: string,
  windowMinutes: number,
  now?: Date,
): Promise<number | null> {
  const sql = withNow(
    now,
    `SELECT ST_Distance(geom::geography, ST_GeomFromText(${shift(now, 1)}, 4326)::geography) / 1000.0 AS dist_km
       FROM afa_pixels
      WHERE observed_at_utc >= $NOW$ - (${shift(now, 2)} || ' minutes')::interval
   ORDER BY geom::geography <-> ST_GeomFromText(${shift(now, 1)}, 4326)::geography
      LIMIT 1`,
  );
  const r = await query(sql, nowParams(now, [centroidWkt, windowMinutes.toString()]));
  return r.rows[0]?.dist_km ?? null;
}

export async function getTimeSinceLastPixelInRadius(
  centroidWkt: string,
  radiusKm: number,
  allclearWaitMin: number,
  now?: Date,
): Promise<number | null> {
  const sql = withNow(
    now,
    `SELECT EXTRACT(EPOCH FROM ($NOW$ - MAX(observed_at_utc))) / 60.0 AS minutes_ago
       FROM afa_pixels
      WHERE ST_DWithin(geom::geography, ST_GeomFromText(${shift(now, 1)}, 4326)::geography, ${shift(now, 2)})
        AND observed_at_utc >= $NOW$ - (${shift(now, 3)} || ' minutes')::interval`,
  );
  const r = await query(sql, nowParams(now, [centroidWkt, radiusKm * 1000, allclearWaitMin.toString()]));
  return r.rows[0]?.minutes_ago ?? null;
}

export async function getAfaTrend(
  centroidWkt: string,
  radiusKm: number,
  now?: Date,
): Promise<{ recent: number; previous: number; trend: string }> {
  const recentSql = withNow(
    now,
    `SELECT COALESCE(SUM(flash_count), 0) AS cnt FROM afa_pixels
       WHERE ST_DWithin(geom::geography, ST_GeomFromText(${shift(now, 1)}, 4326)::geography, ${shift(now, 2)})
         AND observed_at_utc >= $NOW$ - interval '5 minutes'`,
  );
  const prevSql = withNow(
    now,
    `SELECT COALESCE(SUM(flash_count), 0) AS cnt FROM afa_pixels
       WHERE ST_DWithin(geom::geography, ST_GeomFromText(${shift(now, 1)}, 4326)::geography, ${shift(now, 2)})
         AND observed_at_utc >= $NOW$ - interval '15 minutes'
         AND observed_at_utc <  $NOW$ - interval '5 minutes'`,
  );
  const [a, b] = await Promise.all([
    query(recentSql, nowParams(now, [centroidWkt, radiusKm * 1000])),
    query(prevSql, nowParams(now, [centroidWkt, radiusKm * 1000])),
  ]);
  const recent = parseInt(a.rows[0].cnt, 10);
  const previous = parseInt(b.rows[0].cnt, 10);
  let trend = 'stable';
  if (recent > previous * 1.5) trend = 'increasing';
  else if (recent < previous * 0.5) trend = 'decreasing';
  return { recent, previous, trend };
}
```

- [ ] **Step 4.2: Re-export in `server/queries.ts`**

In [server/queries.ts](../../server/queries.ts), extend the bottom `export { ... } from './db'` block to include the new four:

```ts
export {
  countFlashesInRadius,
  getNearestFlashDistance,
  getTimeSinceLastFlashInRadius,
  getFlashTrend,
  getRecentFlashes,
  countLitPixelsAndIncidence,
  nearestLitPixelKm,
  getTimeSinceLastPixelInRadius,
  getAfaTrend,
} from './db';
```

- [ ] **Step 4.3: Commit**

```bash
git add server/db.ts server/queries.ts
git commit -m "feat(afa): PostGIS query helpers for lit-pixel/incidence counting"
```

---

## Task 5: `decideRiskState` rewrite + tests

**Files:**
- Modify: `server/riskEngine.ts` (the pure `decideRiskState` function and its `RiskDecisionInputs` interface)
- Modify: `server/tests/riskEngine.test.ts` (replace fixtures)

- [ ] **Step 5.1: Add new fields to `RiskDecisionInputs`**

In [server/riskEngine.ts](../../server/riskEngine.ts), locate `RiskDecisionInputs`. Add the AFA fields without removing the existing LFL ones (both must coexist during the grace window):

```ts
export interface RiskDecisionInputs {
  // ... existing fields ...
  stop_radius_km: number;
  prepare_radius_km: number;

  // Legacy LFL inputs (used when LIGHTNING_SOURCE=lfl)
  stop_flash_threshold: number;
  prepare_flash_threshold: number;
  stopFlashes: number;
  prepareFlashes: number;
  nearestFlashKm: number | null;
  timeSinceLastFlashMin: number | null;

  // AFA inputs (used when LIGHTNING_SOURCE=afa)
  stop_lit_pixels: number;
  stop_incidence: number;
  prepare_lit_pixels: number;
  prepare_incidence: number;
  litPixelsStop: number;
  litPixelsPrepare: number;
  incidenceStop: number;
  incidencePrepare: number;
  nearestPixelKm: number | null;
  timeSinceLastPixelMin: number | null;

  // Common
  stop_window_min: number;
  prepare_window_min: number;
  allclear_wait_min: number;
  effectivePriorState: RiskState;
  isDegraded: boolean;
  trend: 'stable' | 'increasing' | 'decreasing';

  // Dispatch
  source: 'lfl' | 'afa';
}
```

- [ ] **Step 5.2: Add the AFA decision branch alongside the LFL branch**

The existing `decideRiskState` body uses `stopFlashes`, `prepareFlashes`, `nearestFlashKm` directly. Wrap it: at the top of the function, if `i.source === 'afa'`, dispatch to a new `decideAfa` helper; otherwise use the existing logic.

Add this new function above `decideRiskState`:

```ts
function decideAfa(i: RiskDecisionInputs): { newState: RiskState; reason: string } {
  if (i.isDegraded) {
    return { newState: 'DEGRADED', reason: 'No AFA product received in 27 min. Cannot determine risk.' };
  }

  const proximityKm = Math.max(1, i.stop_radius_km * 0.5);
  const stopTrigger =
    i.litPixelsStop >= i.stop_lit_pixels ||
    i.incidenceStop >= i.stop_incidence;
  const prepareTrigger =
    i.litPixelsPrepare >= i.prepare_lit_pixels ||
    i.incidencePrepare >= i.prepare_incidence;
  const proximityTrigger = i.nearestPixelKm !== null && i.nearestPixelKm < proximityKm;

  if (proximityTrigger) {
    return {
      newState: 'STOP',
      reason: `Lightning detected ${i.nearestPixelKm!.toFixed(1)} km from site (proximity threshold ${proximityKm.toFixed(1)} km). Immediate shelter.`,
    };
  }
  if (stopTrigger) {
    return {
      newState: 'STOP',
      reason: `${i.litPixelsStop} cell(s) lit within ${i.stop_radius_km} km in last ${i.stop_window_min} min (${i.incidenceStop} flash-pixel hits). Trend: ${i.trend}.`,
    };
  }
  if (prepareTrigger) {
    if (i.effectivePriorState === 'STOP' || i.effectivePriorState === 'HOLD') {
      return {
        newState: 'HOLD',
        reason: `STOP cleared but ${i.litPixelsPrepare} cell(s) still lit within ${i.prepare_radius_km} km. Remain sheltered.`,
      };
    }
    return {
      newState: 'PREPARE',
      reason: `${i.litPixelsPrepare} cell(s) lit within ${i.prepare_radius_km} km in last ${i.prepare_window_min} min (${i.incidencePrepare} hits). Trend: ${i.trend}.`,
    };
  }

  // No triggers — check hysteresis from prior STOP/HOLD/PREPARE
  if (
    (i.effectivePriorState === 'STOP' ||
      i.effectivePriorState === 'HOLD' ||
      i.effectivePriorState === 'PREPARE') &&
    i.timeSinceLastPixelMin !== null &&
    i.timeSinceLastPixelMin < i.allclear_wait_min
  ) {
    return {
      newState: i.effectivePriorState === 'PREPARE' ? 'PREPARE' : 'HOLD',
      reason: `No new cells lit but only ${i.timeSinceLastPixelMin.toFixed(0)} min since last activity (≥ ${i.allclear_wait_min} min required).`,
    };
  }

  return {
    newState: 'ALL_CLEAR',
    reason:
      i.timeSinceLastPixelMin !== null
        ? `No cells lit within ${i.prepare_radius_km} km for ${i.timeSinceLastPixelMin.toFixed(0)} min. Feed healthy. Safe to resume.`
        : `No recent cells lit within ${i.prepare_radius_km} km. Feed healthy. Safe to resume.`,
  };
}
```

Add at the top of `decideRiskState`:

```ts
export function decideRiskState(i: RiskDecisionInputs): { newState: RiskState; reason: string } {
  if (i.source === 'afa') return decideAfa(i);
  // ... existing LFL logic untouched below ...
```

- [ ] **Step 5.3: Add AFA-specific test fixtures**

In `server/tests/riskEngine.test.ts`, add after the existing LFL test blocks:

```ts
const baseAfaInputs: RiskDecisionInputs = {
  ...baseInputs,
  source: 'afa',
  stop_lit_pixels: 1,
  stop_incidence: 5,
  prepare_lit_pixels: 1,
  prepare_incidence: 1,
  litPixelsStop: 0,
  litPixelsPrepare: 0,
  incidenceStop: 0,
  incidencePrepare: 0,
  nearestPixelKm: null,
  timeSinceLastPixelMin: null,
};

function withAfa(overrides: Partial<RiskDecisionInputs>): RiskDecisionInputs {
  return { ...baseAfaInputs, ...overrides };
}

describe('decideRiskState — AFA STOP transitions', () => {
  it('escalates to STOP on lit-pixels threshold', () => {
    const r = decideRiskState(withAfa({ litPixelsStop: 1 }));
    expect(r.newState).toBe('STOP');
    expect(r.reason).toMatch(/1 cell\(s\) lit within 10 km/);
  });

  it('escalates to STOP on incidence threshold even with subthreshold lit pixels', () => {
    // 0 lit pixels would be impossible alongside incidence>0, but the OR
    // semantic should still be exercised: one lit cell with high incidence.
    const r = decideRiskState(withAfa({
      litPixelsStop: 1,
      incidenceStop: 5,
      stop_lit_pixels: 2,  // would NOT trip on lit alone (1 < 2)
      stop_incidence: 5,   // trips on incidence
    }));
    expect(r.newState).toBe('STOP');
    expect(r.reason).toMatch(/5 flash-pixel hits/);
  });

  it('escalates to STOP on proximity even with no count thresholds met', () => {
    const r = decideRiskState(withAfa({
      litPixelsStop: 0, incidenceStop: 0, nearestPixelKm: 4,
    }));
    expect(r.newState).toBe('STOP');
    expect(r.reason).toMatch(/proximity threshold/);
  });

  it('proximity threshold is floored at 1 km', () => {
    const r = decideRiskState(withAfa({ stop_radius_km: 1, nearestPixelKm: 0.9 }));
    expect(r.newState).toBe('STOP');
  });
});

describe('decideRiskState — AFA PREPARE/HOLD/ALL_CLEAR', () => {
  it('enters PREPARE on lit-pixels threshold from ALL_CLEAR', () => {
    const r = decideRiskState(withAfa({ litPixelsPrepare: 1 }));
    expect(r.newState).toBe('PREPARE');
  });

  it('downgrades STOP→HOLD when prepare still tripped', () => {
    const r = decideRiskState(withAfa({
      effectivePriorState: 'STOP',
      litPixelsStop: 0,
      litPixelsPrepare: 1,
    }));
    expect(r.newState).toBe('HOLD');
  });

  it('stays HOLD if allclear_wait_min not elapsed', () => {
    const r = decideRiskState(withAfa({
      effectivePriorState: 'STOP',
      litPixelsStop: 0,
      litPixelsPrepare: 0,
      timeSinceLastPixelMin: 10,
      allclear_wait_min: 30,
    }));
    expect(r.newState).toBe('HOLD');
  });

  it('returns ALL_CLEAR when wait elapsed and no activity', () => {
    const r = decideRiskState(withAfa({
      effectivePriorState: 'STOP',
      litPixelsStop: 0,
      litPixelsPrepare: 0,
      timeSinceLastPixelMin: 31,
      allclear_wait_min: 30,
    }));
    expect(r.newState).toBe('ALL_CLEAR');
  });

  it('DEGRADED when isDegraded true regardless of activity', () => {
    const r = decideRiskState(withAfa({ isDegraded: true, litPixelsStop: 100 }));
    expect(r.newState).toBe('DEGRADED');
  });
});
```

Also update `baseInputs` at the top of the test file to include the AFA fields as zero defaults (so existing LFL tests still compile against the extended interface). Add right under the existing keys in `baseInputs`:

```ts
source: 'lfl',
stop_lit_pixels: 1,
stop_incidence: 5,
prepare_lit_pixels: 1,
prepare_incidence: 1,
litPixelsStop: 0,
litPixelsPrepare: 0,
incidenceStop: 0,
incidencePrepare: 0,
nearestPixelKm: null,
timeSinceLastPixelMin: null,
```

- [ ] **Step 5.4: Run the test suite**

```bash
cd server && npm test -- riskEngine
```

Expected: all existing LFL tests still pass, plus 10 new AFA tests.

- [ ] **Step 5.5: Commit**

```bash
git add server/riskEngine.ts server/tests/riskEngine.test.ts
git commit -m "feat(afa): dual-threshold decision logic with lit-pixel + incidence triggers"
```

---

## Task 6: Wire the risk engine through the feature flag

**Files:**
- Modify: `server/riskEngine.ts` (the `evaluateLocation` function around line 306)
- Modify: `server/queries/locations.ts` (SELECT the new threshold columns)

- [ ] **Step 6.1: Update location SELECTs to include new columns**

In [server/queries/locations.ts](../../server/queries/locations.ts), every SELECT that returns `stop_flash_threshold` (lines 37, 49, 62, 107, 147) must additionally select:

```
l.stop_lit_pixels, l.stop_incidence, l.prepare_lit_pixels, l.prepare_incidence
```

And the corresponding `Location` interface (line 13) must add:

```ts
stop_lit_pixels: number;
stop_incidence: number;
prepare_lit_pixels: number;
prepare_incidence: number;
```

The `LocationData` interface used for create/update (line 163) needs the same fields as optional.

The `INSERT` in `createLocation` (line 175) needs the four extra columns and four extra parameter slots with defaults `1, 5, 1, 1`.

- [ ] **Step 6.2: Dispatch the query helpers in `evaluateLocation`**

In [server/riskEngine.ts](../../server/riskEngine.ts) around line 306, replace the four parallel `countFlashesInRadius` / `getFlashTrend` / `getNearestFlashDistance` / `getTimeSinceLastFlashInRadius` calls with a feature-flag dispatch:

```ts
const source = (process.env.LIGHTNING_SOURCE || 'lfl').toLowerCase() === 'afa' ? 'afa' : 'lfl';

let stopFlashes = 0, prepareFlashes = 0;
let nearestFlashKm: number | null = null;
let timeSinceLastFlashMin: number | null = null;
let litPixelsStop = 0, litPixelsPrepare = 0;
let incidenceStop = 0, incidencePrepare = 0;
let nearestPixelKm: number | null = null;
let timeSinceLastPixelMin: number | null = null;
let trendObj: { trend: string };

if (source === 'afa') {
  const [stopCounts, prepareCounts, nearest, sinceLast, trend] = await Promise.all([
    countLitPixelsAndIncidence(centroidWkt, location.stop_radius_km, location.stop_window_min, nowJs),
    countLitPixelsAndIncidence(centroidWkt, location.prepare_radius_km, location.prepare_window_min, nowJs),
    nearestLitPixelKm(centroidWkt, location.prepare_window_min, nowJs),
    getTimeSinceLastPixelInRadius(centroidWkt, location.prepare_radius_km, location.allclear_wait_min, nowJs),
    getAfaTrend(centroidWkt, location.prepare_radius_km, nowJs),
  ]);
  litPixelsStop = stopCounts.litPixels;
  incidenceStop = stopCounts.incidence;
  litPixelsPrepare = prepareCounts.litPixels;
  incidencePrepare = prepareCounts.incidence;
  nearestPixelKm = nearest;
  timeSinceLastPixelMin = sinceLast;
  trendObj = trend;
} else {
  // Existing LFL Promise.all block stays exactly as-is, assigning to
  // stopFlashes, prepareFlashes, nearestFlashKm, timeSinceLastFlashMin, trendObj.
}
```

Then in the call to `decideRiskState`, pass all the new fields plus `source`:

```ts
const decision = decideRiskState({
  source,
  // ... existing fields ...
  stop_lit_pixels: location.stop_lit_pixels,
  stop_incidence: location.stop_incidence,
  prepare_lit_pixels: location.prepare_lit_pixels,
  prepare_incidence: location.prepare_incidence,
  litPixelsStop, litPixelsPrepare, incidenceStop, incidencePrepare,
  nearestPixelKm, timeSinceLastPixelMin,
  // ...
});
```

Update the `risk_states.reason` JSONB write to include the new metric values (around line 404):

```ts
flashes_in_stop_radius: result.stopFlashes ?? 0,
flashes_in_prepare_radius: result.prepareFlashes ?? 0,
lit_pixels_stop: litPixelsStop,
lit_pixels_prepare: litPixelsPrepare,
incidence_stop: incidenceStop,
incidence_prepare: incidencePrepare,
source,
```

- [ ] **Step 6.3: Add imports**

At the top of `server/riskEngine.ts`, extend the import from `./queries`:

```ts
import {
  countFlashesInRadius,
  getFlashTrend,
  getNearestFlashDistance,
  getTimeSinceLastFlashInRadius,
  countLitPixelsAndIncidence,
  nearestLitPixelKm,
  getTimeSinceLastPixelInRadius,
  getAfaTrend,
} from './queries';
```

- [ ] **Step 6.4: Smoke-test under both flag values**

```bash
# With LIGHTNING_SOURCE=lfl in .env
cd server && npm test
# All existing tests pass

# With LIGHTNING_SOURCE=afa
LIGHTNING_SOURCE=afa npm test
# Same — pure-function tests don't read the env at evaluation time
```

For integration: start the server with `LIGHTNING_SOURCE=afa` and watch the risk-engine tick log for absence of "stop_flashes" and presence of "lit_pixels_stop" in reason JSONB.

- [ ] **Step 6.5: Commit**

```bash
git add server/riskEngine.ts server/queries/locations.ts
git commit -m "feat(afa): risk engine dispatches LFL/AFA query helpers on LIGHTNING_SOURCE"
```

---

## Task 7: Update alert template wording

**Files:**
- Modify: `server/alertTemplates.ts`

- [ ] **Step 7.1: Audit current template references**

```bash
grep -n "flash\|Flash" server/alertTemplates.ts
```

The templates read fields out of the `reason` JSONB. After Task 6 the reason now includes `lit_pixels_stop`, `incidence_stop`, etc. alongside the legacy fields.

- [ ] **Step 7.2: Adjust the human-readable lines in `alertTemplates.ts`**

For each template branch that mentions "X flashes within Y km", branch on `reason.source`:

```ts
const bullet = reason.source === 'afa'
  ? `${reason.lit_pixels_stop ?? 0} cells lit within ${stopRadius} km in last ${stopWindow} min ` +
    `(${reason.incidence_stop ?? 0} flash-pixel hits)`
  : `${reason.flashes_in_stop_radius ?? 0} flashes within ${stopRadius} km in last ${stopWindow} min`;
```

Apply the same pattern wherever PREPARE-radius counts are rendered. Plain-English email subjects don't need to change — the technical body is what differs.

- [ ] **Step 7.3: Commit**

```bash
git add server/alertTemplates.ts
git commit -m "feat(afa): alert templates render lit-pixels/incidence when source=afa"
```

---

## Task 8: `GET /api/afa-pixels` endpoint

**Files:**
- Modify: `server/index.ts` (mount the new route alongside existing `/api/flashes`)

- [ ] **Step 8.1: Locate the existing `/api/flashes` handler**

```bash
grep -n "/api/flashes\|getRecentFlashes" server/index.ts
```

- [ ] **Step 8.2: Add the new endpoint nearby**

Below the existing `/api/flashes` route, add:

```ts
app.get(
  '/api/afa-pixels',
  authenticateRequest,
  requireRole('viewer'),
  async (req: AuthedRequest, res) => {
    const since = req.query.since ? new Date(String(req.query.since)) : new Date(Date.now() - 15 * 60_000);
    if (isNaN(since.getTime())) {
      return res.status(400).json({ error: 'invalid since' });
    }
    const bboxRaw = String(req.query.bbox || '');
    const bbox = bboxRaw ? bboxRaw.split(',').map((n) => parseFloat(n)) : null;
    if (bbox && (bbox.length !== 4 || bbox.some(isNaN))) {
      return res.status(400).json({ error: 'bbox must be west,south,east,north' });
    }

    const params: any[] = [since.toISOString()];
    let sql = `
      SELECT observed_at_utc, pixel_lat, pixel_lon, flash_count,
             ST_AsGeoJSON(geom)::json AS geometry
        FROM afa_pixels
       WHERE observed_at_utc >= $1
    `;
    if (bbox) {
      params.push(bbox[0], bbox[1], bbox[2], bbox[3]);
      sql += ` AND geom && ST_MakeEnvelope($2, $3, $4, $5, 4326)`;
    }
    sql += ` ORDER BY observed_at_utc DESC LIMIT 5000`;

    const { rows } = await query(sql, params);
    res.json({
      type: 'FeatureCollection',
      features: rows.map((r) => ({
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
  },
);
```

The `authenticateRequest` and `requireRole` helpers and `AuthedRequest` type are already used elsewhere in [server/index.ts](../../server/index.ts) — match those imports.

- [ ] **Step 8.3: Smoke test**

```bash
curl -b cookies.txt 'http://localhost:4000/api/afa-pixels?since=2026-05-15T00:00:00Z' | jq '.features | length'
```

Expected: a number (0 if no AFA data, >0 if Task 3 ingested anything).

- [ ] **Step 8.4: Commit**

```bash
git add server/index.ts
git commit -m "feat(afa): GET /api/afa-pixels returns GeoJSON FeatureCollection of lit cells"
```

---

## Task 9: WebSocket `afa.update` delta event

**Files:**
- Modify: `server/websocket.ts` (export an emit helper)
- Modify: `server/eumetsatService.ts` (call the helper after each successful AFA ingest)

- [ ] **Step 9.1: Add an emit helper in `server/websocket.ts`**

```bash
grep -n "io\|emit" server/websocket.ts | head -30
```

Below the existing `emitRiskStateChange` / similar helpers, add:

```ts
export function emitAfaUpdate(pixels: Array<{
  observed_at_utc: string;
  pixel_lat: number;
  pixel_lon: number;
  flash_count: number;
  geom_wkt: string;
}>): void {
  if (!ioInstance || pixels.length === 0) return;
  // Broadcast to every org room — AFA data is bbox-clipped to Southern Africa
  // and is not org-scoped at the source level.
  ioInstance.emit('afa.update', { pixels });
}
```

Match the actual variable name for the Socket.IO instance currently used in this file (likely `io` or `ioInstance`).

- [ ] **Step 9.2: Call the helper from the AFA ingester**

In `server/eumetsatService.ts`'s `ingestAfaPixels`, after the loop, collect successful inserts and emit:

```ts
const successfullyInserted: ParsedAfaPixel[] = [];
for (const p of pixels) {
  try {
    await query(
      `INSERT INTO afa_pixels (...) VALUES (...) ON CONFLICT DO NOTHING`,
      [/* ... */],
    );
    successfullyInserted.push(p);
    ingested++;
  } catch (err) {
    // ... existing warn
  }
}
if (successfullyInserted.length > 0) {
  const { emitAfaUpdate } = await import('./websocket');
  emitAfaUpdate(successfullyInserted);
}
return { total: pixels.length, ingested };
```

The dynamic import avoids a cyclic dependency between `eumetsatService` and `websocket`.

- [ ] **Step 9.3: Commit**

```bash
git add server/websocket.ts server/eumetsatService.ts
git commit -m "feat(afa): WebSocket afa.update delta event after each successful ingest"
```

---

## Task 10: Threshold-preview endpoint

**Files:**
- Modify: `server/locationRoutes.ts`

- [ ] **Step 10.1: Add the route**

In [server/locationRoutes.ts](../../server/locationRoutes.ts), after the existing `PUT /:id` handler, add:

```ts
router.post(
  '/:id/preview-thresholds',
  requireRole('admin'),
  async (req: AuthedRequest, res) => {
    const { stop_lit_pixels, stop_incidence, prepare_lit_pixels, prepare_incidence } = req.body;
    if (![stop_lit_pixels, stop_incidence, prepare_lit_pixels, prepare_incidence].every((n) => typeof n === 'number' && n >= 1)) {
      return res.status(400).json({ error: 'all four thresholds required, each >= 1' });
    }
    const location = await getLocationForUser(req.user!, req.params.id);
    if (!location) return res.status(404).json({ error: 'not found' });

    // Walk the last 24 h in 5-minute slices; count how many slices would
    // have tripped STOP or PREPARE under the proposed thresholds.
    const { rows } = await query(
      `WITH slices AS (
         SELECT generate_series(NOW() - interval '24 hours', NOW(), interval '5 minutes') AS slice_end
       )
       SELECT s.slice_end,
              COUNT(*) FILTER (
                WHERE p.observed_at_utc BETWEEN s.slice_end - interval '5 minutes' AND s.slice_end
                  AND ST_DWithin(p.geom::geography, ST_GeomFromText($1, 4326)::geography, $2)
              ) AS lit_stop,
              COALESCE(SUM(p.flash_count) FILTER (
                WHERE p.observed_at_utc BETWEEN s.slice_end - interval '5 minutes' AND s.slice_end
                  AND ST_DWithin(p.geom::geography, ST_GeomFromText($1, 4326)::geography, $2)
              ), 0) AS inc_stop,
              COUNT(*) FILTER (
                WHERE p.observed_at_utc BETWEEN s.slice_end - interval '15 minutes' AND s.slice_end
                  AND ST_DWithin(p.geom::geography, ST_GeomFromText($1, 4326)::geography, $3)
              ) AS lit_prep,
              COALESCE(SUM(p.flash_count) FILTER (
                WHERE p.observed_at_utc BETWEEN s.slice_end - interval '15 minutes' AND s.slice_end
                  AND ST_DWithin(p.geom::geography, ST_GeomFromText($1, 4326)::geography, $3)
              ), 0) AS inc_prep
         FROM slices s
    LEFT JOIN afa_pixels p ON TRUE
        GROUP BY s.slice_end`,
      [location.centroid_wkt, location.stop_radius_km * 1000, location.prepare_radius_km * 1000],
    );

    let stopHits = 0;
    let prepareHits = 0;
    for (const r of rows) {
      if (parseInt(r.lit_stop, 10) >= stop_lit_pixels || parseInt(r.inc_stop, 10) >= stop_incidence) stopHits++;
      if (parseInt(r.lit_prep, 10) >= prepare_lit_pixels || parseInt(r.inc_prep, 10) >= prepare_incidence) prepareHits++;
    }
    res.json({ window_hours: 24, stop_triggers: stopHits, prepare_triggers: prepareHits });
  },
);
```

The exact `getLocationForUser` and `requireRole` symbols match what `locationRoutes.ts` already imports.

- [ ] **Step 10.2: Commit**

```bash
git add server/locationRoutes.ts
git commit -m "feat(afa): POST /:id/preview-thresholds simulates triggers over last 24h"
```

---

## Task 11: Dashboard map — layer-control infrastructure

**Files:**
- Modify: `client/src/Dashboard.tsx`
- Create: `client/src/MapLayers/index.ts` (barrel)
- Create: `client/src/MapLayers/useAfaPixels.ts` (data hook)

- [ ] **Step 11.1: Data hook for AFA pixels**

Create `client/src/MapLayers/useAfaPixels.ts`:

```ts
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useSocket } from '../socket'; // existing helper; match the actual export name

export interface AfaPixel {
  observed_at_utc: string;
  pixel_lat: number;
  pixel_lon: number;
  flash_count: number;
  geometry: GeoJSON.Polygon;
}

const WINDOW_MIN = 15; // longest window we render

export function useAfaPixels(): AfaPixel[] {
  const [pixels, setPixels] = useState<AfaPixel[]>([]);
  const socket = useSocket();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const since = new Date(Date.now() - WINDOW_MIN * 60_000).toISOString();
      const { data } = await api.get<{ features: any[] }>(`/api/afa-pixels?since=${since}`);
      if (cancelled) return;
      setPixels(data.features.map((f) => ({ ...f.properties, geometry: f.geometry })));
    }
    load();
    const fallback = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(fallback); };
  }, []);

  useEffect(() => {
    if (!socket) return;
    const handler = (msg: { pixels: AfaPixel[] }) => {
      setPixels((prev) => {
        const cutoff = Date.now() - WINDOW_MIN * 60_000;
        const keyed = new Map(prev.map((p) => [`${p.pixel_lat},${p.pixel_lon}`, p]));
        for (const np of msg.pixels) keyed.set(`${np.pixel_lat},${np.pixel_lon}`, np);
        return [...keyed.values()].filter((p) => new Date(p.observed_at_utc).getTime() >= cutoff);
      });
    };
    socket.on('afa.update', handler);
    return () => { socket.off('afa.update', handler); };
  }, [socket]);

  return pixels;
}
```

If the socket helper in this codebase has a different shape (e.g., a singleton imported directly rather than a hook), adapt the second `useEffect` to the existing pattern in [Dashboard.tsx](../../client/src/Dashboard.tsx).

- [ ] **Step 11.2: Layer-control widget in `Dashboard.tsx`**

Below the Leaflet `MapContainer` JSX (or wherever the map is mounted in `Dashboard.tsx`), wrap it in a `LayersControl`:

```tsx
import { LayersControl } from 'react-leaflet';
import { HeatmapLayer } from './MapLayers/HeatmapLayer';
import { CellsByRecencyLayer } from './MapLayers/CellsByRecencyLayer';
import { CellsByIncidenceLayer } from './MapLayers/CellsByIncidenceLayer';
import { ThreatPolygonLayer } from './MapLayers/ThreatPolygonLayer';
import { useAfaPixels } from './MapLayers/useAfaPixels';

// ... inside the component:
const afaPixels = useAfaPixels();

// ... inside JSX:
<LayersControl position="topright">
  <LayersControl.Overlay checked name="Heatmap">
    <HeatmapLayer pixels={afaPixels} />
  </LayersControl.Overlay>
  <LayersControl.Overlay name="Cells by recency">
    <CellsByRecencyLayer pixels={afaPixels} />
  </LayersControl.Overlay>
  <LayersControl.Overlay name="Cells by incidence">
    <CellsByIncidenceLayer pixels={afaPixels} />
  </LayersControl.Overlay>
  <LayersControl.Overlay name="Threat polygons">
    <ThreatPolygonLayer />
  </LayersControl.Overlay>
</LayersControl>
```

- [ ] **Step 11.3: Commit**

```bash
git add client/src/Dashboard.tsx client/src/MapLayers/
git commit -m "feat(afa): map layer control infrastructure + AFA pixel data hook"
```

---

## Task 12: Heatmap layer (default visible)

**Files:**
- Create: `client/src/MapLayers/HeatmapLayer.tsx`

- [ ] **Step 12.1: Implement the component**

```tsx
import { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet.heat';
import { AfaPixel } from './useAfaPixels';

interface Props { pixels: AfaPixel[]; }

export function HeatmapLayer({ pixels }: Props) {
  const map = useMap();
  useEffect(() => {
    const points: Array<[number, number, number]> = pixels.map((p) => [
      p.pixel_lat, p.pixel_lon, p.flash_count,
    ]);
    // @ts-expect-error - leaflet.heat is not in the typing for L
    const layer = L.heatLayer(points, { radius: 30, blur: 25, max: 10 });
    layer.addTo(map);
    return () => { map.removeLayer(layer); };
  }, [map, pixels]);
  return null;
}
```

- [ ] **Step 12.2: Manual smoke test**

```bash
cd client && npm run dev
# Open http://localhost:3000, log in, view dashboard
# Verify a heatmap layer appears if any AFA pixels exist
```

- [ ] **Step 12.3: Commit**

```bash
git add client/src/MapLayers/HeatmapLayer.tsx
git commit -m "feat(afa): heatmap layer using leaflet.heat (default visible)"
```

---

## Task 13: Cells-by-recency layer

**Files:**
- Create: `client/src/MapLayers/CellsByRecencyLayer.tsx`

- [ ] **Step 13.1: Implement**

```tsx
import { GeoJSON } from 'react-leaflet';
import L from 'leaflet';
import { AfaPixel } from './useAfaPixels';

function recencyColor(ageMs: number): string {
  if (ageMs < 30_000) return '#fff200';      // bright yellow
  if (ageMs < 120_000) return '#ff9800';     // orange
  return '#b71c1c';                          // faint red
}

interface Props { pixels: AfaPixel[]; }

export function CellsByRecencyLayer({ pixels }: Props) {
  const now = Date.now();
  const features = pixels
    .filter((p) => now - new Date(p.observed_at_utc).getTime() < 5 * 60_000)
    .map((p) => ({
      type: 'Feature' as const,
      geometry: p.geometry,
      properties: { ageMs: now - new Date(p.observed_at_utc).getTime() },
    }));
  return (
    <GeoJSON
      key={`recency-${pixels.length}-${now}`}
      data={{ type: 'FeatureCollection', features }}
      pathOptions={{ weight: 0 }}
      style={(f: any) => ({
        color: recencyColor(f.properties.ageMs),
        fillColor: recencyColor(f.properties.ageMs),
        fillOpacity: 0.6,
        weight: 0,
      })}
      // canvas rendering — see spec section 6.4
      renderer={L.canvas() as any}
    />
  );
}
```

- [ ] **Step 13.2: Commit**

```bash
git add client/src/MapLayers/CellsByRecencyLayer.tsx
git commit -m "feat(afa): cells-by-recency map layer (yellow→orange→red ramp)"
```

---

## Task 14: Cells-by-incidence layer

**Files:**
- Create: `client/src/MapLayers/CellsByIncidenceLayer.tsx`

- [ ] **Step 14.1: Implement**

```tsx
import { GeoJSON } from 'react-leaflet';
import L from 'leaflet';
import { AfaPixel } from './useAfaPixels';

function incidenceColor(count: number): string {
  // Pale → saturated red ramp, 1..≥10
  const t = Math.min(1, (count - 1) / 9);
  const r = 255;
  const gb = Math.round(220 - t * 200);
  return `rgb(${r},${gb},${gb})`;
}

interface Props { pixels: AfaPixel[]; }

export function CellsByIncidenceLayer({ pixels }: Props) {
  const features = pixels.map((p) => ({
    type: 'Feature' as const,
    geometry: p.geometry,
    properties: { count: p.flash_count },
  }));
  return (
    <GeoJSON
      key={`incidence-${pixels.length}`}
      data={{ type: 'FeatureCollection', features }}
      style={(f: any) => ({
        color: incidenceColor(f.properties.count),
        fillColor: incidenceColor(f.properties.count),
        fillOpacity: 0.7,
        weight: 0,
      })}
      renderer={L.canvas() as any}
    />
  );
}
```

- [ ] **Step 14.2: Commit**

```bash
git add client/src/MapLayers/CellsByIncidenceLayer.tsx
git commit -m "feat(afa): cells-by-incidence map layer (pale→saturated by flash_count)"
```

---

## Task 15: Threat-polygons layer

**Files:**
- Create: `client/src/MapLayers/ThreatPolygonLayer.tsx`
- Modify: `server/index.ts` (new endpoint `GET /api/afa-threat-polygons`)

- [ ] **Step 15.1: Add the server endpoint**

In [server/index.ts](../../server/index.ts), below `/api/afa-pixels`:

```ts
app.get(
  '/api/afa-threat-polygons',
  authenticateRequest,
  requireRole('viewer'),
  async (req: AuthedRequest, res) => {
    const orgId = req.user!.org_id;
    const { rows } = await query(
      `SELECT l.id AS location_id, l.name,
              ST_AsGeoJSON(
                ST_Union(p.geom)
              )::json AS geometry
         FROM locations l
         JOIN afa_pixels p
           ON ST_DWithin(p.geom::geography, l.centroid::geography, l.prepare_radius_km * 1000)
          AND p.observed_at_utc >= NOW() - (l.prepare_window_min || ' minutes')::interval
        WHERE l.org_id = $1 AND l.enabled = true
        GROUP BY l.id, l.name`,
      [orgId],
    );
    res.json({
      type: 'FeatureCollection',
      features: rows.map((r) => ({
        type: 'Feature',
        geometry: r.geometry,
        properties: { location_id: r.location_id, location_name: r.name },
      })),
    });
  },
);
```

- [ ] **Step 15.2: Implement the layer**

```tsx
import { useEffect, useState } from 'react';
import { GeoJSON } from 'react-leaflet';
import L from 'leaflet';
import { api } from '../api';

export function ThreatPolygonLayer() {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    const load = async () => {
      const { data } = await api.get('/api/afa-threat-polygons');
      setData(data);
    };
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);
  if (!data) return null;
  return (
    <GeoJSON
      key={`threat-${Date.now()}`}
      data={data}
      style={{ color: '#d50000', weight: 3, fillOpacity: 0 }}
      renderer={L.canvas() as any}
    />
  );
}
```

- [ ] **Step 15.3: Commit**

```bash
git add server/index.ts client/src/MapLayers/ThreatPolygonLayer.tsx
git commit -m "feat(afa): threat-polygons endpoint and bold-outline map layer"
```

---

## Task 16: LocationEditor — threshold UI + live preview

**Files:**
- Modify: `client/src/LocationEditor.tsx`
- Modify: `server/locationRoutes.ts` (accept new fields in POST/PUT bodies)
- Modify: `server/validators.ts` (Zod schema)

- [ ] **Step 16.1: Extend validators**

In [server/validators.ts](../../server/validators.ts), add to the location schema:

```ts
stop_lit_pixels: z.number().int().min(1).optional(),
stop_incidence: z.number().int().min(1).optional(),
prepare_lit_pixels: z.number().int().min(1).optional(),
prepare_incidence: z.number().int().min(1).optional(),
```

- [ ] **Step 16.2: Accept fields in route handlers**

In [server/locationRoutes.ts](../../server/locationRoutes.ts), the POST `/` and PUT `/:id` handlers should pass through the new fields into the existing `createLocation` / `updateLocation` calls. Match the existing pattern.

- [ ] **Step 16.3: UI section in `LocationEditor.tsx`**

Find the existing threshold form section (it references `stop_flash_threshold`). Replace it with:

```tsx
<h3>Risk thresholds</h3>
<p style={{ fontSize: 12, color: '#666' }}>
  STOP fires if EITHER condition is met within {stopRadius} km in the last {stopWindow} min.
</p>
<label>Lit 2 km cells ≥
  <input type="number" min={1} value={form.stop_lit_pixels}
    onChange={(e) => setForm({...form, stop_lit_pixels: parseInt(e.target.value, 10)})} />
</label>
<label>Total incidence ≥
  <input type="number" min={1} value={form.stop_incidence}
    onChange={(e) => setForm({...form, stop_incidence: parseInt(e.target.value, 10)})} />
</label>

<p style={{ fontSize: 12, color: '#666', marginTop: 16 }}>
  PREPARE fires similarly within {prepareRadius} km in the last {prepareWindow} min.
</p>
<label>Lit cells ≥
  <input type="number" min={1} value={form.prepare_lit_pixels}
    onChange={(e) => setForm({...form, prepare_lit_pixels: parseInt(e.target.value, 10)})} />
</label>
<label>Incidence ≥
  <input type="number" min={1} value={form.prepare_incidence}
    onChange={(e) => setForm({...form, prepare_incidence: parseInt(e.target.value, 10)})} />
</label>

{preview && (
  <div style={{ marginTop: 12, padding: 8, background: '#f5f5f5', fontSize: 13 }}>
    Your current thresholds would have triggered:
    <strong> {preview.stop_triggers}× STOP, {preview.prepare_triggers}× PREPARE </strong>
    in the last 24 h.
  </div>
)}
<button type="button" onClick={runPreview}>Preview triggers (last 24h)</button>
```

Where `runPreview` is:

```tsx
const [preview, setPreview] = useState<{ stop_triggers: number; prepare_triggers: number } | null>(null);
const runPreview = async () => {
  const { data } = await api.post(`/api/locations/${id}/preview-thresholds`, {
    stop_lit_pixels: form.stop_lit_pixels,
    stop_incidence: form.stop_incidence,
    prepare_lit_pixels: form.prepare_lit_pixels,
    prepare_incidence: form.prepare_incidence,
  });
  setPreview(data);
};
```

Match the existing form-state pattern used in the file — if it uses Material-UI components or react-hook-form, port these to that idiom.

- [ ] **Step 16.4: Smoke test in browser**

Start the client, navigate to a location's edit page, change `stop_lit_pixels`, click Preview triggers, see the count, save the location, verify the database row.

- [ ] **Step 16.5: Commit**

```bash
git add client/src/LocationEditor.tsx server/locationRoutes.ts server/validators.ts
git commit -m "feat(afa): location editor dual-threshold UI with 24h trigger preview"
```

---

## Task 17: Replay endpoint switch + replay UI

**Files:**
- Modify: `server/index.ts` (the existing `/api/replay/:locationId` handler)
- Modify: the replay UI component (likely `client/src/Replay.tsx` or similar)

- [ ] **Step 17.1: Locate the replay endpoint**

```bash
grep -rn "/api/replay" server/ client/src/ | head
```

- [ ] **Step 17.2: Branch the handler on `LIGHTNING_SOURCE`**

Inside the existing replay handler, replace the `flash_events` SELECT with:

```ts
const source = (process.env.LIGHTNING_SOURCE || 'lfl').toLowerCase();
if (source === 'afa') {
  const { rows } = await query(
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
    type: 'FeatureCollection',
    features: rows.map((r) => ({ type: 'Feature', geometry: r.geometry, properties: { ...r } })),
  });
}
// ... existing LFL branch unchanged ...
```

- [ ] **Step 17.3: Branch the replay client**

In the replay component, check `response.source`. If `'afa'`, render via the `<GeoJSON>` overlay with a time scrubber that filters features by `observed_at_utc`. If `'lfl'`, keep the existing point-marker code.

- [ ] **Step 17.4: Commit**

```bash
git add server/index.ts client/src/Replay.tsx
git commit -m "feat(afa): replay endpoint and viewer support polygon source when AFA active"
```

---

## Task 18: Historical backfill script

**Files:**
- Create: `ingestion/backfill_afa.py`

- [ ] **Step 18.1: Implement the script**

```python
#!/usr/bin/env python3
"""
Backfill afa_pixels for the storm dates used by replay-demo locations.

Usage:
  EUMETSAT_CONSUMER_KEY=… EUMETSAT_CONSUMER_SECRET=… \
  DATABASE_URL=postgres://… \
  python backfill_afa.py
"""
import os
import re
import sys
import json
import subprocess
import tempfile
import zipfile
from base64 import b64encode
from datetime import datetime, timedelta, timezone

import psycopg2
import psycopg2.extras
import requests

EUMETSAT_TOKEN = 'https://api.eumetsat.int/token'
EUMETSAT_SEARCH = 'https://api.eumetsat.int/data/search-products/1.0.0/os'
EUMETSAT_DL = 'https://api.eumetsat.int/data/download/1.0.0/collections'
COLLECTION = os.environ.get('EUMETSAT_AFA_COLLECTION_ID', 'EO:EUM:DAT:0687')
PARSER = os.path.join(os.path.dirname(__file__), 'parse_afa_nc_json.py')

DATE_RE = re.compile(r'\b(\d{4}-\d{2}-\d{2})\b')


def get_token() -> str:
    key = os.environ['EUMETSAT_CONSUMER_KEY']
    sec = os.environ['EUMETSAT_CONSUMER_SECRET']
    auth = b64encode(f'{key}:{sec}'.encode()).decode()
    r = requests.post(
        EUMETSAT_TOKEN,
        headers={'Authorization': f'Basic {auth}', 'Content-Type': 'application/x-www-form-urlencoded'},
        data='grant_type=client_credentials',
    )
    r.raise_for_status()
    return r.json()['access_token']


def find_targets(cur) -> list[dict]:
    cur.execute("""
      SELECT id, name FROM locations
       WHERE name ILIKE '%replay demo%' OR name ILIKE '%storm demo%'
    """)
    targets = []
    for row in cur.fetchall():
        m = DATE_RE.search(row['name'])
        if not m:
            print(f"skipping {row['name']!r}: no YYYY-MM-DD", file=sys.stderr)
            continue
        date = datetime.strptime(m.group(1), '%Y-%m-%d').replace(tzinfo=timezone.utc)
        # Find the actual flash time range from flash_events for this location's date
        cur.execute("""
          SELECT MIN(flash_time_utc) AS start, MAX(flash_time_utc) AS end
            FROM flash_events
           WHERE flash_time_utc::date = %s
        """, (date.date(),))
        r = cur.fetchone()
        if not r or not r['start']:
            # No LFL evidence — use the whole day
            start = date
            end = date + timedelta(days=1)
        else:
            start = r['start'] - timedelta(minutes=30)
            end = r['end'] + timedelta(minutes=30)
        targets.append({'location_id': row['id'], 'name': row['name'], 'start': start, 'end': end})
    return targets


def download_and_parse(token: str, product_id: str) -> list[dict]:
    coll = requests.utils.quote(COLLECTION, safe='')
    pid = requests.utils.quote(product_id, safe='')
    dl = requests.get(f'{EUMETSAT_DL}/{coll}/products/{pid}', headers={'Authorization': f'Bearer {token}'})
    if dl.status_code != 200:
        return []
    with tempfile.TemporaryDirectory() as td:
        zpath = os.path.join(td, 'a.zip')
        with open(zpath, 'wb') as f:
            f.write(dl.content)
        nc_path = None
        try:
            with zipfile.ZipFile(zpath) as z:
                for n in z.namelist():
                    if n.endswith('.nc'):
                        z.extract(n, td)
                        nc_path = os.path.join(td, n)
                        break
        except zipfile.BadZipFile:
            # Some products download as raw netCDF
            nc_path = zpath
        if not nc_path:
            return []
        proc = subprocess.run([sys.executable, PARSER, nc_path], capture_output=True, text=True)
        if proc.returncode != 0:
            print(f'parser failed: {proc.stderr}', file=sys.stderr)
            return []
        return json.loads(proc.stdout)


def insert_pixels(cur, product_id: str, pixels: list[dict]) -> int:
    psycopg2.extras.execute_values(
        cur,
        """INSERT INTO afa_pixels (product_id, observed_at_utc, pixel_lat, pixel_lon, geom, flash_count)
           VALUES %s ON CONFLICT DO NOTHING""",
        [(product_id, p['observed_at_utc'], p['pixel_lat'], p['pixel_lon'],
          f"SRID=4326;{p['geom_wkt']}", p['flash_count']) for p in pixels],
        template="(%s, %s, %s, %s, ST_GeomFromEWKT(%s), %s)",
    )
    return len(pixels)


def main() -> int:
    conn = psycopg2.connect(os.environ['DATABASE_URL'], cursor_factory=psycopg2.extras.DictCursor)
    cur = conn.cursor()
    token = get_token()

    targets = find_targets(cur)
    print(f'targets: {len(targets)}')
    for t in targets:
        print(f"  {t['name']}: {t['start'].isoformat()} → {t['end'].isoformat()}")

    for t in targets:
        r = requests.get(
            EUMETSAT_SEARCH,
            headers={'Authorization': f'Bearer {token}'},
            params={
                'pi': COLLECTION,
                'dtstart': t['start'].isoformat(),
                'dtend': t['end'].isoformat(),
                'format': 'json',
                'c': '500',
            },
        )
        r.raise_for_status()
        features = r.json().get('features', [])
        print(f"  {t['name']}: {len(features)} products")
        for feat in features:
            pid = feat['id']
            cur.execute('SELECT 1 FROM ingestion_log WHERE product_id = %s', (pid,))
            if cur.fetchone():
                continue
            pixels = download_and_parse(token, pid)
            inserted = insert_pixels(cur, pid, pixels) if pixels else 0
            cur.execute(
                """INSERT INTO ingestion_log
                   (product_id, product_time_start, product_time_end, flash_count, ingested_at, qc_status)
                   VALUES (%s, %s, %s, %s, NOW(), %s) ON CONFLICT DO NOTHING""",
                (pid, t['start'], t['end'], inserted, 'OK' if inserted else 'LOW_COUNT'),
            )
            conn.commit()
    return 0


if __name__ == '__main__':
    sys.exit(main())
```

- [ ] **Step 18.2: Dry-run against staging**

```bash
DATABASE_URL=… EUMETSAT_CONSUMER_KEY=… EUMETSAT_CONSUMER_SECRET=… \
  python ingestion/backfill_afa.py
```

Verify the printed target list contains your replay-demo locations. Watch row counts increase in `afa_pixels`.

- [ ] **Step 18.3: Commit**

```bash
git add ingestion/backfill_afa.py
git commit -m "feat(afa): backfill script for replay-demo storm dates"
```

---

## Task 18.5: Docs updates

**Files:**
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`

- [ ] **Step 18.5.1: Update README.md "Risk Engine Logic" section**

Replace the existing bullet list under "Risk Engine Logic" so it describes the dual-threshold AFA model:

```markdown
The engine evaluates each location every 60 seconds:

1. **Data freshness**: If no AFA product ingested in 25 min → DEGRADED
2. **STOP check**:
   - Lit 2 km cells in stop_radius ≥ stop_lit_pixels, OR
   - Sum of flash_count in those cells ≥ stop_incidence, OR
   - Any lit cell within max(1, stop_radius/2) km (proximity override)
3. **PREPARE check**: Same OR semantic, against prepare_radius / prepare_window
4. **HOLD**: After STOP, wait allclear_wait_min with no new activity before ALL CLEAR
5. **ALL CLEAR**: No cells lit within prepare_radius for ≥ allclear_wait_min AND feed healthy
```

Also update the "Configuration" table to list `stop_lit_pixels`, `stop_incidence`, `prepare_lit_pixels`, `prepare_incidence` instead of the old `_threshold` fields.

- [ ] **Step 18.5.2: Update `docs/ARCHITECTURE.md` ingestion diagram**

In the mermaid `flowchart LR` block near the top, replace `EUMETSAT[EUMETSAT Data Store<br/>MTG LI-2-LFL]` with `EUMETSAT[EUMETSAT Data Store<br/>MTG LI-2-AFA]` and change the ingestion-stage labels from "netCDF4 .nc"/"flash dicts"/"bulk INSERT flash_events" to AFA equivalents ("grid netCDF", "lit pixels", "bulk INSERT afa_pixels"). Update the "Ingestion pipeline" mermaid further down the same file likewise.

In the "Data model" mermaid `erDiagram`, replace the `flash_events` entity with:

```
afa_pixels {
  bigserial id PK
  text product_id
  timestamptz observed_at_utc
  geometry geom "POLYGON 4326"
  integer flash_count
}
```

Update the "Key non-obvious behaviours" table to remove the LFL-specific entries that no longer apply post-cutover.

- [ ] **Step 18.5.3: Commit**

```bash
git add README.md docs/ARCHITECTURE.md
git commit -m "docs(afa): rewrite Risk Engine Logic + ingestion diagrams for AFA"
```

---

## Task 19: Cutover runbook

**Files:**
- None — operational steps only.

- [ ] **Step 19.1: Pre-flight check**

```bash
# Confirm staging has been running on LIGHTNING_SOURCE=afa for >24h with no errors
fly logs -a flashaware-api-staging | grep -i 'afa' | tail -100
fly ssh console -a flashaware-api-staging -C \
  "psql \$DATABASE_URL -c 'SELECT COUNT(*), MIN(observed_at_utc), MAX(observed_at_utc) FROM afa_pixels'"
```

- [ ] **Step 19.2: Run backfill against production**

```bash
DATABASE_URL=$(fly secrets list -a flashaware-db) \
EUMETSAT_CONSUMER_KEY=… EUMETSAT_CONSUMER_SECRET=… \
python ingestion/backfill_afa.py
```

- [ ] **Step 19.3: Flip the production flag**

```bash
fly secrets set LIGHTNING_SOURCE=afa -a flashaware-api
# This triggers a rolling restart.
```

- [ ] **Step 19.4: Watch the first risk-engine tick**

```bash
fly logs -a flashaware-api | grep -iE 'lit_pixels|incidence|risk-state-change'
```

Within 60 s you should see `lit_pixels_stop`/`incidence_stop` in the risk-state JSONB. No flash-count references.

- [ ] **Step 19.5: Verify the dashboard**

Open `https://lightning-risk-api.fly.dev`, log in, confirm the map shows the heatmap layer by default and the layer toggle exposes the other three. Pick a demo replay location and confirm the replay UI renders polygons.

- [ ] **Step 19.6: Monitor for 1 h**

Watch `/api/health` (the `feedHealthy` flag) and the alert volume. If alerts spike abnormally or `feedHealthy` flips to false, run Step 19.7.

- [ ] **Step 19.7: Rollback procedure (only if needed)**

```bash
fly secrets set LIGHTNING_SOURCE=lfl -a flashaware-api
# LFL data is still being written to flash_events during the grace window,
# so this reverts cleanly. Open a GitHub issue with the logs that triggered
# the rollback before next attempt.
```

---

## Task 20: Decommission (next weekend, after 7+ days of stable AFA operation)

**Files:**
- Modify: `server/migrate.ts` (one-shot DROP migration)
- Modify: `db/schema.sql` (remove `flash_events` and the old threshold columns)
- Modify: `server/eumetsatService.ts` (delete LFL branches)
- Modify: `server/riskEngine.ts` (delete LFL branch of `decideRiskState`)
- Modify: `server/db.ts` (delete LFL flash query helpers)
- Delete: `ingestion/parse_nc_json.py`

- [ ] **Step 20.1: Decommission migration**

In `server/migrate.ts`:

```ts
await runOnce('20260524-drop-lfl', async () => {
  await query(`DROP TABLE IF EXISTS flash_events CASCADE`);
  await query(`
    ALTER TABLE locations
      DROP COLUMN IF EXISTS stop_flash_threshold,
      DROP COLUMN IF EXISTS prepare_flash_threshold
  `);
});
```

- [ ] **Step 20.2: Delete LFL code paths**

Remove from `server/eumetsatService.ts`: `parseNetCDF`, `ingestFlashes`, `runIngestionCycle` (the LFL one), the `cycleFn` dispatch (just always call `runAfaIngestionCycle`).

Remove from `server/riskEngine.ts`: the `i.source === 'lfl'` branch and the `RiskDecisionInputs` legacy fields.

Remove from `server/db.ts`: `countFlashesInRadius`, `getNearestFlashDistance`, `getTimeSinceLastFlashInRadius`, `getFlashTrend`, `getRecentFlashes`. Update `server/queries.ts` accordingly.

Remove the `LIGHTNING_SOURCE` env-var read everywhere (it always defaults to `afa` post-decommission, and the LFL branches are gone).

Delete `ingestion/parse_nc_json.py`.

- [ ] **Step 20.3: Remove env vars**

In `.env.example`, delete `LIGHTNING_SOURCE` and `EUMETSAT_AFA_COLLECTION_ID` (the AFA collection becomes the only one, so the `EUMETSAT_COLLECTION_ID` default in code can change to `EO:EUM:DAT:0687`).

```bash
fly secrets unset LIGHTNING_SOURCE EUMETSAT_AFA_COLLECTION_ID -a flashaware-api
fly secrets set EUMETSAT_COLLECTION_ID=EO:EUM:DAT:0687 -a flashaware-api
```

- [ ] **Step 20.4: Run tests + smoke + deploy**

```bash
cd server && npm test
cd ../client && npm run build
fly deploy -a flashaware-api
```

- [ ] **Step 20.5: Commit and tag**

```bash
git add .
git commit -m "feat(afa): decommission LFL ingestion path after successful cutover"
git tag afa-cutover-complete
```

---

## Self-Review Notes

- Spec section 1 (problem) → Pre-work + Task 19 (cutover) summary.
- Spec section 3 (architecture) → Tasks 1, 2, 3.
- Spec section 4 (risk-engine semantics) → Tasks 5, 6.
- Spec section 5 (migration + backfill + cutover) → Tasks 18, 19, 20.
- Spec section 6 (map UI) → Tasks 11–15.
- Spec section 7 (per-location config) → Tasks 10, 16.
- Spec section 8 (file list) → matches the Files: declarations in every task.
- Spec section 9 (testing) → Tasks 2 (parser), 5 (decideRiskState), 19 (manual smoke).
- Spec section 10 (open questions on defaults) → addressed by Task 16's preview endpoint (Task 10) and post-cutover tuning in Task 19.

Type consistency check: `ParsedAfaPixel` (Task 3), `AfaPixel` (Task 11 hook), and `RiskDecisionInputs.litPixelsStop`/`incidenceStop` etc. (Task 5) all use the same key names. `emitAfaUpdate` (Task 9) takes the same shape as the JSON the parser emits in Task 2.

Placeholder scan: no TODOs, no "add appropriate error handling," every code block is real and runnable. The only deferred work is the verification step in Task 2.1 (real EUMETSAT product inspection), which is intentionally an *investigation* step rather than a placeholder.

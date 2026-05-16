# AFA Lightning Migration — Design

**Date:** 2026-05-15
**Status:** Draft, awaiting user review
**Author:** Brainstorm session with Klaus
**Scope:** Replace LI-2-LFL flash-point ingestion with LI-2-AFA 2 km grid-pixel ingestion. Hard cutover targeted for Sunday 2026-05-17 evening.

---

## 1. Background & Problem Statement

FlashAware currently ingests EUMETSAT collection **`EO:EUM:DAT:0691` (LI-2-LFL — Lightning Flashes)** at [`server/eumetsatService.ts:104`](../../server/eumetsatService.ts) and the Python parser at [`ingestion/parse_nc_json.py`](../../ingestion/parse_nc_json.py) extracts a single `latitude`/`longitude` per flash. These centroids are stored as `POINT` geometries in [`flash_events.geom`](../../db/schema.sql) and the risk engine evaluates `ST_DWithin(centroid, point, radius)` against them.

Per the EUMETSAT LFL Product User Guide (slide 19 of `PINEDA_EUMETRAIN_20230927print.pdf`) the LFL `latitude`/`longitude` is the **central coordinate of a clustered group of pixels**, not a precise strike location. The actual lightning footprint can span tens of km² — already partially captured by the `flash_footprint` variable we ingest but never use.

The downstream effect: a flash whose centroid sits 14 km from a mine can have its body 8 km away — well inside a 10 km `stop_radius_km` we're choosing to ignore. This is a false-negative failure mode in a life-safety product.

**LI-2-AFA (Accumulated Flash Area, `EO:EUM:DAT:0687`)** provides the same data on the native 2 km FCI grid: per pixel, the count of flashes whose optical emission touched that cell in the accumulation window. This is the resolution we should be working at.

This spec is the migration plan: retire LFL, ingest AFA, redesign the risk engine and UI around grid pixels rather than centroid points.

---

## 2. Goals & Non-goals

**Goals**

- Risk decisions made against the real spatial extent of each flash, at 2 km resolution.
- Replace `flash_events` (point) with `afa_pixels` (polygon) as the authoritative lightning table.
- Preserve the existing five-state risk machine (STOP / HOLD / PREPARE / ALL CLEAR / DEGRADED) and hysteresis behaviour.
- Backfill AFA for the storm dates used by the existing replay-demo locations so the demo flow still works.
- Ship by Sunday 2026-05-17 evening for the demo-only production deployment.

**Non-goals**

- Pre-cutover staging burn-in. (Demo-only prod means thresholds are calibrated post-cutover.)
- Translating existing per-location `stop_flash_threshold` values into the new units. (Defaults applied; operators reset per location if they want.)
- Backwards compatibility with the LFL collection beyond the 7-day grace period.
- Changes to email/SMS/WhatsApp templates beyond the `reason` text body.

---

## 3. Architecture

### 3.1 Ingestion path

```
EUMETSAT (EO:EUM:DAT:0687, half-minute AFA products)
  ↓ download_product       (existing OAuth flow, new collection id)
  ↓ parse_afa_nc_json.py   (new parser; 2D grid → sparse non-zero pixels)
  ↓ ingest_afa_pixels      (Node; INSERT rows clipped to Southern Africa bbox)
  ↓
afa_pixels table  (PostGIS, GIST indexed)
```

Reused infrastructure: OAuth flow ([`getAccessToken`](../../server/eumetsatService.ts)), product search and download, `ingestion_log` table for product-level idempotency, advisory-lock leader gating, heartbeat writes, the chained-setTimeout scheduler.

The Python parser is genuinely new because AFA is a grid product, not a feature list. It reads the AFA netCDF variables for the 2 km FCI grid, filters to the Southern Africa bounding box (same constants as today's `SA_BBOX`), and emits one JSON object per non-zero pixel:

```json
{
  "observed_at_utc": "2026-05-15T12:34:30Z",
  "pixel_lat": -26.2,
  "pixel_lon": 28.04,
  "flash_count": 3
}
```

### 3.2 Schema

```sql
CREATE TABLE afa_pixels (
  id              BIGSERIAL PRIMARY KEY,
  product_id      TEXT NOT NULL,
  -- Intentionally NOT a FK to ingestion_log: the ingester writes pixels
  -- BEFORE the ingestion_log row (see runAfaIngestionCycle), so an FK
  -- would reject every insert.
  observed_at_utc TIMESTAMPTZ NOT NULL,
  pixel_lat       REAL NOT NULL,
  pixel_lon       REAL NOT NULL,
  geom            GEOMETRY(POLYGON, 4326) NOT NULL,
  flash_count     INTEGER NOT NULL CHECK (flash_count > 0),
  CONSTRAINT uq_afa_pixel UNIQUE (product_id, pixel_lat, pixel_lon)
);
CREATE INDEX idx_afa_pixels_time ON afa_pixels (observed_at_utc);
CREATE INDEX idx_afa_pixels_geom ON afa_pixels USING GIST (geom);
```

`pixel_lat`/`pixel_lon` are denormalised for debugging and the `UNIQUE` constraint; the authoritative geometry is `geom`, a 2 km × 2 km polygon centred on the pixel coordinate. The polygon is constructed in the parser using a constant ~0.018 deg lat / ~0.020 deg lng offset (adjusted by cos(lat) for longitude) — close enough to 2 km at the latitudes we care about.

Retention: the existing `runRetention` job in [`server/index.ts`](../../server/index.ts) drops `afa_pixels` rows older than 30 days alongside the existing alerts/flash_events sweeps.

Storage estimate: ~1 MB/day (sparse storage of only non-zero pixels). ~30 MB at 30-day retention. Negligible.

### 3.3 Cadence

Ingest AFA at its native 30 s cadence. Each pixel stored as one row. Roll up at query time for whatever window the risk engine asks for (`stop_window_min` = 5, `prepare_window_min` = 15, etc.). No pre-aggregation in storage — the GIST index on `geom` plus the B-tree on `observed_at_utc` keep risk-engine queries fast.

EUMETSAT poll interval stays at 120 s. Each poll picks up ~4 new half-minute products, ingests them sequentially.

---

## 4. Risk-engine semantics

### 4.1 Dual thresholds

Each location grows from one threshold per state to two:

| Field                | Default | Meaning                                                                 |
| -------------------- | ------- | ----------------------------------------------------------------------- |
| `stop_lit_pixels`    | 1       | Distinct 2 km cells with any activity inside `stop_radius_km` to trip STOP |
| `stop_incidence`     | 5       | Summed AFA flash_count across those cells to trip STOP                    |
| `prepare_lit_pixels` | 1       | Same, for `prepare_radius_km`                                            |
| `prepare_incidence`  | 1       | Same                                                                     |

STOP fires if `lit_pixels ≥ stop_lit_pixels` **OR** `incidence ≥ stop_incidence`. PREPARE same. `stop_window_min` and `prepare_window_min` remain unchanged.

The OR semantic means either wide coverage **or** intense activity trips the alarm. A single very active pixel (`flash_count = 5`) trips STOP even if it's only one cell.

### 4.2 Proximity safety override

Today's code at [`server/riskEngine.ts:125`](../../server/riskEngine.ts) trips STOP unconditionally if any flash is within `max(1, stop_radius_km × 0.5)` km. The AFA equivalent: trip STOP unconditionally if any `afa_pixels.geom` intersects that inner radius, regardless of count or incidence thresholds. This guarantees a nearby strike always wins.

### 4.3 `decideRiskState` rewrite

Pure function in [`server/riskEngine.ts`](../../server/riskEngine.ts), unit-tested without a DB. New input shape:

```ts
interface RiskInput {
  litPixelsStop: number;
  litPixelsPrepare: number;
  incidenceStop: number;
  incidencePrepare: number;
  nearestPixelKm: number | null;
  timeSinceLastPixelMin: number | null;
  feedHealthy: boolean;
  stop_lit_pixels: number;
  stop_incidence: number;
  prepare_lit_pixels: number;
  prepare_incidence: number;
  stop_radius_km: number;
  prepare_radius_km: number;
  stop_window_min: number;
  prepare_window_min: number;
  allclear_wait_min: number;
  trend: 'increasing' | 'steady' | 'decreasing';
}
```

State machine, hysteresis, DEGRADED transitions, cold-start suppression, and effective-prior-state logic remain identical. Only the trigger conditions change.

### 4.4 DB query helpers

Two new helpers replace `countFlashesInRadius` and `getFlashTrend` in [`server/queries.ts`](../../server/queries.ts):

```ts
countLitPixelsAndIncidence(centroidWkt, radiusKm, windowMin, now)
  → { litPixels: number; incidence: number }

nearestLitPixelKm(centroidWkt, radiusKm, windowMin, now)
  → number | null

getAfaTrend(centroidWkt, radiusKm, now)
  → 'increasing' | 'steady' | 'decreasing'
```

All three use `ST_DWithin(geom::geography, centroid::geography, radius_m)` for great-circle distance against the GIST-indexed polygon column.

### 4.5 Feed-health threshold

DEGRADED still triggers on 25 min of no successful EUMETSAT poll. AFA's 30 s cadence means a healthy feed delivers ~120 files/h; the 25-min ceiling tolerates the longest publishing gap EUMETSAT has historically had.

### 4.6 Alert "why" wording

JSONB `reason` drives email/SMS bodies via [`alertTemplates.ts`](../../server/alertTemplates.ts). New phrasing:

| State        | Reason example                                                                            |
| ------------ | ----------------------------------------------------------------------------------------- |
| STOP         | "4 cells lit within 10 km in last 5 min (12 flash-pixel hits). Trend: increasing."        |
| STOP (near)  | "Lightning detected 0.8 km from site. Immediate shelter."                                 |
| PREPARE      | "2 cells lit within 20 km in last 15 min (5 hits). STOP threshold not yet met."           |
| HOLD         | "STOP conditions cleared but cells still lit within 20 km. Remain sheltered."             |
| ALL CLEAR    | "No cells lit within 20 km for 31 min. Feed healthy. Safe to resume."                     |
| DEGRADED     | "No AFA product received in 27 min. Cannot determine risk."                               |

---

## 5. Migration & cutover plan (weekend-compressed)

Demo-only production means we can skip staging burn-in and rely on a fast feature-flag rollback if needed.

### 5.1 Feature flag

New env var `LIGHTNING_SOURCE = lfl | afa` (default `lfl`). All new AFA code is gated behind it. Risk engine reads it once per evaluation cycle and dispatches to the LFL or AFA code path accordingly.

### 5.2 Sequence

| Phase   | When           | Action                                                                                                  |
| ------- | -------------- | ------------------------------------------------------------------------------------------------------- |
| Build 1 | Sat AM         | AFA ingester, Python parser, `afa_pixels` schema migration, feature flag wired in                       |
| Build 2 | Sat PM         | Risk-engine query helpers, `decideRiskState` rewrite, threshold-column migration, unit tests             |
| Build 3 | Sat eve        | Map UI: four toggleable layers, heatmap default; new `/api/afa-pixels` REST + WS `afa.update` event     |
| Deploy  | Sun AM         | Deploy to staging with `LIGHTNING_SOURCE=afa`, ingest live AFA, eyeball against current LFL display     |
| Backfill | Sun PM        | Run `backfill_afa.py` for replay-demo storm dates; verify replay UI renders polygons                    |
| Cutover | Sun eve        | Flip `LIGHTNING_SOURCE=afa` in production; monitor `risk_states` and alert volume for ≥1 h              |
| Tune    | Mon → Fri      | Adjust thresholds based on real-storm behaviour; iterate on UI feedback                                 |
| Drop    | Next weekend   | Stop LFL ingestion; drop `flash_events` table; remove LFL parser; remove feature flag                   |

### 5.3 Backfill

[`ingestion/backfill_afa.py`](../../ingestion/backfill_afa.py) — new one-off script:

1. Query production for locations whose `name` matches the demo-replay pattern (containing `Replay demo` and a parseable `YYYY-MM-DD`).
2. For each, parse the storm date and query `flash_events` for the actual flash time range on that date for that location (typically a 1–3 h window).
3. Call EUMETSAT search API for AFA products in that range (`EO:EUM:DAT:0687`, `dtstart`/`dtend` set to the storm window ± 30 min).
4. Download each product, run through the same parser used by the live ingester, INSERT rows into `afa_pixels`.
5. Idempotent: re-running the script over an already-backfilled date is a no-op via `ingestion_log` and the unique constraint on `afa_pixels`.

Runs from a maintenance host (a local laptop, or one-off Fly.io machine) — not the production API box.

### 5.4 Threshold column migration

Single Postgres migration adds the four new threshold columns with defaults `(stop_lit_pixels=1, stop_incidence=5, prepare_lit_pixels=1, prepare_incidence=1)`. CHECK constraints enforce `>= 1`. Existing rows pick up the defaults atomically.

We do **not** attempt to translate existing `stop_flash_threshold` values — the units don't carry over and the new defaults are conservative enough that no location becomes less safe. The old columns are kept in the schema during the 7-day grace period and dropped in the decommission migration.

### 5.5 Rollback

Until decommission day:

- Flip `LIGHTNING_SOURCE=lfl` in prod → risk engine reverts to LFL points immediately.
- `flash_events` is still being written by the legacy ingester during the grace period.
- New AFA columns on `locations` are nullable-free with defaults; no behaviour change to old-engine code paths.

After decommission day (next weekend): rollback path is gone. That's intentional — keeping two ingestion pipelines forever is a recipe for divergence.

---

## 6. Map UI

Four layers, all driven off `afa_pixels` via REST + WebSocket. Default visible: heatmap only. Layer control widget at top-right.

### 6.1 Layers

1. **Heatmap (default).** [`leaflet.heat`](https://github.com/Leaflet/Leaflet.heat). Weight = `flash_count`. Radius 30 px, blur 25 px, max 10. Soft and approachable.
2. **Cells by recency.** GeoJSON polygons of `afa_pixels.geom`. Fill colour ramp: bright yellow (last 30 s) → orange (≤2 min) → faint red (≤5 min). Older cells dropped from the layer.
3. **Cells by incidence.** Same polygons; colour intensity proportional to `flash_count` (1 → pale, ≥10 → saturated). No recency fade.
4. **Threat polygons.** Server-side `ST_Union` of all lit pixels within `prepare_radius_km` and `prepare_window_min`. One bold outline polygon per location, no fill.

### 6.2 Data delivery

- **REST:** new endpoint `GET /api/afa-pixels?since=ISO8601&bbox=…` returns a FeatureCollection capped at 5 000 features. The Dashboard polls this every 30 s as a fallback.
- **WebSocket:** new event `afa.update` carries the delta of pixels new since the client's last seen `observed_at_utc`. Reliable delivery via the existing `org:<org_id>` room. Emitted from the ingester after each successful product parse.
- Clients merge incoming pixels by `(pixel_lat, pixel_lon)` key and drop pixels older than the longest active window.

### 6.3 Replay

Replay reads from `/api/afa-pixels` with fixed `since`+`until`+`locationId` filter. Same four layers. Playback scrub is client-side filtering of the loaded feature set by `observed_at_utc`. No extra API calls during scrub.

### 6.4 Performance

Worst-case mid-storm: ~500 lit pixels × 4 layers = ~2000 polygons in the DOM. Leaflet handles this fine if cells use canvas rendering. Layer init must specify `L.canvas()` to avoid the SVG-per-feature trap.

### 6.5 Legend

Tiny static legend in the bottom-left explaining the colour ramp of whichever layer is active. Switches automatically with layer selection.

---

## 7. Per-location config UI

[`client/src/LocationEditor.tsx`](../../client/src/LocationEditor.tsx) gets a redesigned "Risk thresholds" section that replaces the old flash-count fields:

```
─ Risk thresholds ──────────────────────────────
  STOP fires if EITHER condition is met within
  stop_radius_km in the last stop_window_min:

  ▸ Lit 2 km cells ≥ [ 1 ]
    Number of distinct 2 km grid cells with any
    lightning activity inside the radius.

  ▸ Total incidence ≥ [ 5 ]
    Sum of flash-pixel hits across those cells.
    Catches intense activity even on few cells.

  PREPARE fires similarly inside prepare_radius_km
  with its own thresholds:
  ▸ Lit cells ≥ [ 1 ]   ▸ Incidence ≥ [ 1 ]
─────────────────────────────────────────────────
```

Each field carries a tooltip linking to a short explainer paragraph.

**Threshold preview.** Below the form: a live preview pulls the location's last 24 h of `afa_pixels` and shows "Your current thresholds would have triggered: 2 × STOP, 5 × PREPARE in the last 24 h." Drives operator tuning intuition.

Server endpoint: `POST /api/locations/:id/preview-thresholds` runs the threshold simulation against stored data without writing any `risk_states` rows.

**API.** [`server/locationRoutes.ts`](../../server/locationRoutes.ts) accepts the four new optional fields with Zod validation matching the CHECK constraints. Old `stop_flash_threshold` and `prepare_flash_threshold` fields accepted but ignored for one release; removed in the decommission migration.

---

## 8. Files touched (preliminary)

**New**
- `ingestion/parse_afa_nc_json.py`
- `ingestion/backfill_afa.py`
- `server/afaService.ts` (live AFA ingester)
- `client/src/MapLayers/HeatmapLayer.tsx`
- `client/src/MapLayers/CellsByRecencyLayer.tsx`
- `client/src/MapLayers/CellsByIncidenceLayer.tsx`
- `client/src/MapLayers/ThreatPolygonLayer.tsx`
- DB migration: `db/migrations/2026-05-15_afa.sql`
- DB decommission migration: `db/migrations/2026-05-24_drop_lfl.sql`

**Modified**
- `server/eumetsatService.ts` — feature-flag dispatch on `LIGHTNING_SOURCE`
- `server/riskEngine.ts` — `decideRiskState` rewrite, dual-threshold logic
- `server/queries.ts` — new `countLitPixelsAndIncidence`, `nearestLitPixelKm`, `getAfaTrend`
- `server/locationRoutes.ts` — accept new threshold fields
- `server/validators.ts` — Zod schemas for new threshold fields
- `server/alertTemplates.ts` — new `reason` text wording
- `server/index.ts` — `runRetention` sweeps `afa_pixels`; `/api/afa-pixels` endpoint
- `server/websocket.ts` — `afa.update` event emission
- `client/src/Dashboard.tsx` — replace flash markers with layer control + four layers
- `client/src/LocationEditor.tsx` — new threshold UI section + preview
- `client/src/AlertHistory.tsx` — render new `reason` strings
- `db/schema.sql` — `afa_pixels` table + threshold columns on `locations`
- `README.md` — update Risk Engine Logic section, defaults table
- `docs/ARCHITECTURE.md` — update ingestion diagram + state machine descriptions

---

## 9. Testing

- `server/tests/riskEngine.test.ts` — new fixtures for AFA pixel rows, all existing decision-table tests rewritten for the dual-threshold model.
- New `server/tests/afaParser.test.ts` (Vitest) using a small fixture netCDF generated once and committed.
- Manual smoke test on staging Sunday AM: ingest one live AFA product, verify rows in `afa_pixels`, verify dashboard map renders all four layers, verify a synthetic threshold trip produces an alert end-to-end.
- Threshold-preview endpoint: assert idempotent and side-effect-free (no `risk_states` writes).

---

## 10. Open questions

None blocking. Defaults for `stop_lit_pixels = 1` and `stop_incidence = 5` are educated guesses; will be tuned post-cutover from real demo storm behaviour.

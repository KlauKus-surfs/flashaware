import { DateTime } from 'luxon';
import {
  getAllLocations,
  markLocationBootstrapped,
  addRiskState,
  getLatestRiskState,
  getLastNonDegradedState,
  countFlashesInRadius,
  getNearestFlashDistance,
  getTimeSinceLastFlashInRadius,
  getLatestIngestionTime,
  getFlashTrend,
  getRecentAlertsForLocation,
  countLitPixelsAndIncidence,
  nearestLitPixelKm,
  getTimeSinceLastPixelInRadius,
  getAfaTrend,
  LocationRecord,
  RiskStateRecord,
} from './queries';
import { dispatchAlerts, dispatchFeedHealthNotice } from './alertService';
import { parseCentroid } from './db';
import { riskEngineLogger } from './logger';
import { wsManager } from './websocket';

export type RiskState = 'ALL_CLEAR' | 'PREPARE' | 'STOP' | 'HOLD' | 'DEGRADED';

interface EngineLocation {
  id: string;
  org_id: string;
  name: string;
  site_type: string;
  lat: number;
  lng: number;
  stop_radius_km: number;
  prepare_radius_km: number;
  stop_flash_threshold: number;
  stop_window_min: number;
  prepare_flash_threshold: number;
  prepare_window_min: number;
  stop_lit_pixels: number;
  stop_incidence: number;
  prepare_lit_pixels: number;
  prepare_incidence: number;
  allclear_wait_min: number;
  persistence_alert_min: number;
  alert_on_change_only: boolean;
  enabled: boolean;
  // Durable cold-start marker mirrored from `locations.bootstrapped_at`.
  // NULL on the very first evaluation; afterwards the engine writes NOW()
  // so a process restart can't reset the "first ever" suppression flag.
  bootstrapped_at: string | null;
}

// Helper to convert LocationRecord to EngineLocation and extract coordinates
function locationToEngine(loc: LocationRecord): EngineLocation {
  const { lng, lat } = parseCentroid(loc.centroid);

  return {
    id: loc.id,
    org_id: loc.org_id,
    name: loc.name,
    site_type: loc.site_type,
    lat,
    lng,
    stop_radius_km: loc.stop_radius_km,
    prepare_radius_km: loc.prepare_radius_km,
    stop_flash_threshold: loc.stop_flash_threshold,
    stop_window_min: loc.stop_window_min,
    prepare_flash_threshold: loc.prepare_flash_threshold,
    prepare_window_min: loc.prepare_window_min,
    stop_lit_pixels: loc.stop_lit_pixels ?? 1,
    stop_incidence: loc.stop_incidence ?? 5,
    prepare_lit_pixels: loc.prepare_lit_pixels ?? 1,
    prepare_incidence: loc.prepare_incidence ?? 1,
    allclear_wait_min: loc.allclear_wait_min,
    persistence_alert_min: loc.persistence_alert_min ?? 10,
    alert_on_change_only: loc.alert_on_change_only ?? false,
    enabled: loc.enabled,
    bootstrapped_at: loc.bootstrapped_at ?? null,
  };
}

interface EvaluationResult {
  locationId: string;
  locationName: string;
  newState: RiskState;
  previousState: RiskState | null;
  stopFlashes: number;
  prepareFlashes: number;
  nearestFlashKm: number | null;
  dataAgeSec: number;
  isDegraded: boolean;
  trend: string;
  reason: string;
  source: 'lfl' | 'afa';
  litPixelsStop: number;
  litPixelsPrepare: number;
  incidenceStop: number;
  incidencePrepare: number;
}

const STALE_DATA_THRESHOLD_MIN = 25;
const DEGRADED_ALLCLEAR_BLOCK_MIN = 15;

// ---------------------------------------------------------------------------
// Pure state-machine decision. Extracted so it can be exhaustively tested
// without a database. evaluateLocation() is the thin wrapper that fetches
// the inputs from PostGIS and then defers to this function.
// ---------------------------------------------------------------------------
export interface RiskDecisionInputs {
  stop_radius_km: number;
  prepare_radius_km: number;
  stop_flash_threshold: number;
  stop_window_min: number;
  prepare_flash_threshold: number;
  prepare_window_min: number;
  allclear_wait_min: number;
  effectivePriorState: RiskState | null;
  isDegraded: boolean;
  stopFlashes: number;
  prepareFlashes: number;
  nearestFlashKm: number | null;
  trend: string;
  // Minutes since the most recent flash inside the stop radius (within the
  // allclear_wait_min lookback window). Only consulted when no STOP/PREPARE
  // criteria are met AND the prior state requires a wait.
  timeSinceLastFlashMin: number | null;
  // Set when this tick is the first non-DEGRADED tick after a feed outage.
  // While true, the engine refuses to honour the "no flashes recorded → null
  // → ALL CLEAR" shortcut: we have no idea what happened during the outage,
  // so descend through HOLD instead. Cleared once we've observed the airspace
  // for a full allclear_wait_min window.
  feedJustRecovered?: boolean;

  // ---------------------------------------------------------------------------
  // AFA (LI-2-AFA) branch — coexists with the LFL branch during the 7-day
  // grace window. Dispatch is controlled by `source`.
  // ---------------------------------------------------------------------------
  source: 'lfl' | 'afa';

  // AFA thresholds
  stop_lit_pixels: number;
  stop_incidence: number;
  prepare_lit_pixels: number;
  prepare_incidence: number;

  // AFA inputs
  litPixelsStop: number;
  litPixelsPrepare: number;
  incidenceStop: number;
  incidencePrepare: number;
  nearestPixelKm: number | null;
  timeSinceLastPixelMin: number | null;
}

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

  // Feed just came back online while a prior STOP/HOLD/PREPARE was in
  // effect — the absence of pixel records is uninformative because we
  // didn't observe the airspace during the outage. Force a full
  // allclear_wait_min observation window before clearing.
  if (
    i.timeSinceLastPixelMin === null &&
    !i.isDegraded &&
    i.feedJustRecovered &&
    (i.effectivePriorState === 'STOP' ||
      i.effectivePriorState === 'HOLD' ||
      i.effectivePriorState === 'PREPARE')
  ) {
    const newState: RiskState = i.effectivePriorState === 'PREPARE' ? 'PREPARE' : 'HOLD';
    const waitText = `${i.allclear_wait_min} min`;
    const reason =
      newState === 'PREPARE'
        ? `Feed just recovered from outage; observing for ${waitText} before clearing. Stay alert.`
        : `Feed just recovered from outage; observing for ${waitText} before clearing. Stay sheltered.`;
    return { newState, reason };
  }

  return {
    newState: 'ALL_CLEAR',
    reason:
      i.timeSinceLastPixelMin !== null
        ? `No cells lit within ${i.prepare_radius_km} km for ${i.timeSinceLastPixelMin.toFixed(0)} min. Feed healthy. Safe to resume.`
        : `No recent cells lit within ${i.prepare_radius_km} km. Feed healthy. Safe to resume.`,
  };
}

export function decideRiskState(i: RiskDecisionInputs): { newState: RiskState; reason: string } {
  if (i.source === 'afa') return decideAfa(i);

  // Proximity threshold — see comment in original implementation. Scales with
  // configured stop_radius_km (50%, floored at 1 km) so 1km-radius locations
  // don't get phantom-STOP'd by 5km flashes and 50km-radius locations don't
  // miss a 6km strike due to an old hard-coded 5.
  const proximityKm = Math.max(1, i.stop_radius_km * 0.5);

  if (
    i.stopFlashes >= i.stop_flash_threshold ||
    (i.nearestFlashKm !== null && i.nearestFlashKm < proximityKm)
  ) {
    const parts: string[] = [];
    if (i.stopFlashes >= i.stop_flash_threshold) {
      parts.push(
        `${i.stopFlashes} flash(es) within ${i.stop_radius_km} km in last ${i.stop_window_min} min`,
      );
    }
    if (i.nearestFlashKm !== null && i.nearestFlashKm < proximityKm) {
      parts.push(
        `nearest flash at ${i.nearestFlashKm.toFixed(1)} km (< ${proximityKm.toFixed(1)} km proximity threshold)`,
      );
    }
    return { newState: 'STOP', reason: parts.join('; ') + `. Trend: ${i.trend}.` };
  }

  if (i.prepareFlashes >= i.prepare_flash_threshold) {
    if (i.effectivePriorState === 'STOP' || i.effectivePriorState === 'HOLD') {
      return {
        newState: 'HOLD',
        reason: `${i.prepareFlashes} flash(es) within ${i.prepare_radius_km} km in last ${i.prepare_window_min} min. STOP conditions no longer met but threat persists. Trend: ${i.trend}.`,
      };
    }
    return {
      newState: 'PREPARE',
      reason: `${i.prepareFlashes} flash(es) within ${i.prepare_radius_km} km in last ${i.prepare_window_min} min. Trend: ${i.trend}.`,
    };
  }

  // No flashes in either radius — determine if we can clear.
  //
  // Hard invariant: NEVER issue ALL_CLEAR while the feed is degraded, even
  // when the prior state was already ALL_CLEAR. The feed-degraded path is
  // normally caught upstream in evaluateLocation (which short-circuits to
  // DEGRADED before calling here), but we enforce the same guarantee at the
  // decision-function boundary so any future caller — tests, replay tools,
  // a hypothetical alternate evaluator — can't accidentally clear with
  // stale data.
  if (i.isDegraded) {
    return {
      newState: 'DEGRADED',
      reason: `Data feed degraded — cannot determine risk. Holding prior posture.`,
    };
  }
  // Honour allclear_wait_min when descending from STOP, HOLD, or PREPARE.
  const needsWait =
    i.effectivePriorState === 'STOP' ||
    i.effectivePriorState === 'HOLD' ||
    i.effectivePriorState === 'PREPARE';
  if (!needsWait) {
    return {
      newState: 'ALL_CLEAR',
      reason: `No flashes within ${i.prepare_radius_km} km in last ${i.prepare_window_min} min. Data feed healthy.`,
    };
  }

  if (i.timeSinceLastFlashMin === null && !i.isDegraded && !i.feedJustRecovered) {
    return {
      newState: 'ALL_CLEAR',
      reason: `No flash records within ${i.stop_radius_km} km. Data feed healthy. Safe to resume operations.`,
    };
  }
  // Feed just came back online while a prior STOP/HOLD/PREPARE was in
  // effect — the absence of flash records is uninformative because we
  // didn't observe the airspace during the outage. Force a full
  // allclear_wait_min observation window before clearing.
  if (i.timeSinceLastFlashMin === null && !i.isDegraded && i.feedJustRecovered) {
    const newState: RiskState = i.effectivePriorState === 'PREPARE' ? 'PREPARE' : 'HOLD';
    const waitText = `${i.allclear_wait_min} min`;
    const reason =
      newState === 'PREPARE'
        ? `Feed just recovered from outage; observing for ${waitText} before clearing. Stay alert.`
        : `Feed just recovered from outage; observing for ${waitText} before clearing. Stay sheltered.`;
    return { newState, reason };
  }
  if (
    i.timeSinceLastFlashMin !== null &&
    i.timeSinceLastFlashMin >= i.allclear_wait_min &&
    !i.isDegraded
  ) {
    return {
      newState: 'ALL_CLEAR',
      reason: `No flashes within ${i.stop_radius_km} km for ${i.timeSinceLastFlashMin.toFixed(0)} min (≥ ${i.allclear_wait_min} min threshold). Safe to resume operations.`,
    };
  }
  // Coming down from PREPARE stays as PREPARE during wait, STOP/HOLD stays as HOLD
  const newState: RiskState = i.effectivePriorState === 'PREPARE' ? 'PREPARE' : 'HOLD';
  const waitRemaining =
    i.timeSinceLastFlashMin !== null
      ? Math.max(0, i.allclear_wait_min - i.timeSinceLastFlashMin)
      : i.allclear_wait_min;
  const reason =
    newState === 'PREPARE'
      ? `Threat reducing but ALL CLEAR criteria not yet met. ${Math.ceil(waitRemaining)} min remaining. Stay alert.`
      : `No active threat but ALL CLEAR criteria not yet met. ${Math.ceil(waitRemaining)} min remaining. Stay sheltered.`;
  return { newState, reason };
}

let engineRunning = false;
// setTimeout-based scheduler (instead of setInterval) so we can serialise
// runEvaluation() calls properly. With setInterval, a slow evaluation
// (e.g. SMTP/Twilio backpressure on a stormy night) caused the next tick
// to fire before the previous one returned. The in-process `engineRunning`
// guard turned that into a no-op, but the no-ops bunched future ticks
// against the wall clock — net effect: evaluations fired at 60, 60+ε,
// 60+2ε, … instead of every 60s. Now: each tick awaits the previous one,
// then re-arms with the configured interval. If an evaluation overruns,
// the next tick fires the configured interval AFTER it finishes.
let engineTimer: ReturnType<typeof setTimeout> | null = null;
let engineStopped = false;

async function getEnabledLocations(): Promise<EngineLocation[]> {
  const locations = await getAllLocations();
  return locations.filter((l) => l.enabled).map(locationToEngine);
}

async function getCurrentState(locationId: string): Promise<RiskState | null> {
  const rs = await getLatestRiskState(locationId);
  return (rs?.state as RiskState) ?? null;
}

async function evaluateLocation(
  location: EngineLocation,
  // Pre-fetched feed-freshness value, shared across every location in one
  // engine tick. Without this, evaluateLocation queries `ingestion_log` per
  // location even though the answer is the same for the whole tick — at
  // 300+ locations that's 300 redundant Postgres roundtrips every 60s.
  // Pass `undefined` to fall back to the per-call fetch (legacy callers,
  // tests).
  preFetchedLatestIngestion?: Date | null,
  // Tick-scoped "now". The freshness check is computed against THIS instant,
  // and so is every spatial query (countFlashesInRadius / NearestFlashDistance
  // / TimeSinceLastFlash / FlashTrend each take a `now` and substitute it for
  // their NOW() reference). Without this, the JS-side dataAge math used
  // Date.now() while Postgres queries used NOW() at execution — across a
  // 300-location tick those drift by many seconds, producing false "feed
  // healthy + zero flashes → ALL_CLEAR" decisions when the feed crossed the
  // staleness boundary mid-tick. Default to `new Date()` for legacy callers.
  tickNow?: Date,
): Promise<EvaluationResult> {
  const nowJs = tickNow ?? new Date();

  // 1. Data freshness check
  const latestIngestion =
    preFetchedLatestIngestion !== undefined
      ? preFetchedLatestIngestion
      : await getLatestIngestionTime();
  let dataAgeSec = 9999;
  let isDegraded = false;

  if (latestIngestion) {
    dataAgeSec = Math.floor((nowJs.getTime() - latestIngestion.getTime()) / 1000);
    isDegraded = dataAgeSec > STALE_DATA_THRESHOLD_MIN * 60;
  } else {
    isDegraded = true;
  }

  if (isDegraded) {
    return {
      locationId: location.id,
      locationName: location.name,
      newState: 'DEGRADED',
      previousState: await getCurrentState(location.id),
      stopFlashes: 0,
      prepareFlashes: 0,
      nearestFlashKm: null,
      dataAgeSec,
      isDegraded: true,
      trend: 'unknown',
      reason: `No data for ${Math.floor(dataAgeSec / 60)} min. Last product: ${latestIngestion || 'never'}. Cannot determine risk.`,
      source: (process.env.LIGHTNING_SOURCE || 'lfl').toLowerCase() === 'afa' ? 'afa' : 'lfl',
      litPixelsStop: 0,
      litPixelsPrepare: 0,
      incidenceStop: 0,
      incidencePrepare: 0,
    };
  }

  // 2. Spatial queries (PostGIS) — dispatched based on LIGHTNING_SOURCE
  const centroidWkt = `POINT(${location.lng} ${location.lat})`;
  const source = (process.env.LIGHTNING_SOURCE || 'lfl').toLowerCase() === 'afa' ? 'afa' : 'lfl';

  let stopFlashes = 0, prepareFlashes = 0;
  let nearestFlashKm: number | null = null;
  let timeSinceLastFlashMin: number | null = null;
  let litPixelsStop = 0, litPixelsPrepare = 0;
  let incidenceStop = 0, incidencePrepare = 0;
  let nearestPixelKm: number | null = null;
  let timeSinceLastPixelMin: number | null = null;
  let trendData: { trend: string };

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
    trendData = trend;
  } else {
    const [sf, pf, nfk, td] = await Promise.all([
      countFlashesInRadius(centroidWkt, location.stop_radius_km, location.stop_window_min, nowJs),
      countFlashesInRadius(
        centroidWkt,
        location.prepare_radius_km,
        location.prepare_window_min,
        nowJs,
      ),
      getNearestFlashDistance(centroidWkt, location.stop_window_min, nowJs),
      getFlashTrend(centroidWkt, location.prepare_radius_km, nowJs),
    ]);
    stopFlashes = sf;
    prepareFlashes = pf;
    nearestFlashKm = nfk;
    trendData = td;
  }

  const currentState = await getCurrentState(location.id);

  // Resolve effective prior state: if currently DEGRADED, look back for last real state
  // so the all-clear wait is honoured on recovery.
  let effectivePriorState: RiskState | null = currentState;
  if (currentState === 'DEGRADED') {
    const lastReal = await getLastNonDegradedState(location.id);
    effectivePriorState = lastReal;
  }

  // We just transitioned out of DEGRADED if the previous tick recorded
  // DEGRADED but the current freshness check passes. While that is true the
  // decision function refuses the "no records → ALL CLEAR" shortcut for
  // STOP/HOLD/PREPARE descents — see RiskDecisionInputs.feedJustRecovered.
  const feedJustRecovered = currentState === 'DEGRADED' && !isDegraded;

  // 3. Fetch time-since-last-flash only when the no-flashes branch *and* a
  // wait is required (descending from STOP/HOLD/PREPARE). Avoids a DB hit on
  // the hot path where flashes are present. (LFL branch only.)
  if (source === 'lfl') {
    const proximityKmCheck = Math.max(1, location.stop_radius_km * 0.5);
    const noStopOrPrepareConditions =
      stopFlashes < location.stop_flash_threshold &&
      !(nearestFlashKm !== null && nearestFlashKm < proximityKmCheck) &&
      prepareFlashes < location.prepare_flash_threshold;
    const needsWait =
      effectivePriorState === 'STOP' ||
      effectivePriorState === 'HOLD' ||
      effectivePriorState === 'PREPARE';
    timeSinceLastFlashMin =
      noStopOrPrepareConditions && needsWait
        ? await getTimeSinceLastFlashInRadius(
            centroidWkt,
            location.stop_radius_km,
            location.allclear_wait_min,
            nowJs,
          )
        : null;
  }

  const decision = decideRiskState({
    source,
    stop_radius_km: location.stop_radius_km,
    prepare_radius_km: location.prepare_radius_km,
    stop_flash_threshold: location.stop_flash_threshold,
    stop_window_min: location.stop_window_min,
    prepare_flash_threshold: location.prepare_flash_threshold,
    prepare_window_min: location.prepare_window_min,
    stop_lit_pixels: location.stop_lit_pixels,
    stop_incidence: location.stop_incidence,
    prepare_lit_pixels: location.prepare_lit_pixels,
    prepare_incidence: location.prepare_incidence,
    allclear_wait_min: location.allclear_wait_min,
    effectivePriorState,
    isDegraded,
    stopFlashes,
    prepareFlashes,
    nearestFlashKm,
    trend: trendData.trend,
    timeSinceLastFlashMin,
    feedJustRecovered,
    litPixelsStop,
    litPixelsPrepare,
    incidenceStop,
    incidencePrepare,
    nearestPixelKm,
    timeSinceLastPixelMin,
  });
  const { newState, reason } = decision;

  return {
    locationId: location.id,
    locationName: location.name,
    newState,
    previousState: currentState,
    stopFlashes,
    prepareFlashes,
    nearestFlashKm,
    dataAgeSec,
    isDegraded,
    trend: trendData.trend,
    reason,
    source,
    litPixelsStop,
    litPixelsPrepare,
    incidenceStop,
    incidencePrepare,
  };
}

async function logEvaluation(result: EvaluationResult): Promise<bigint> {
  const now = DateTime.utc().toISO()!;
  const id = await addRiskState({
    location_id: result.locationId,
    state: result.newState,
    previous_state: result.previousState,
    changed_at: now,
    reason: {
      reason: result.reason,
      flashes_in_stop_radius: result.stopFlashes ?? 0,
      flashes_in_prepare_radius: result.prepareFlashes ?? 0,
      nearestFlashKm: result.nearestFlashKm,
      dataAgeSec: result.dataAgeSec,
      trend: result.trend,
      lit_pixels_stop: result.litPixelsStop,
      lit_pixels_prepare: result.litPixelsPrepare,
      incidence_stop: result.incidenceStop,
      incidence_prepare: result.incidencePrepare,
      source: result.source,
    },
    flashes_in_stop_radius: result.stopFlashes,
    flashes_in_prepare_radius: result.prepareFlashes,
    nearest_flash_km: result.nearestFlashKm,
    data_age_sec: result.dataAgeSec,
    is_degraded: result.isDegraded,
    evaluated_at: now,
  });
  return BigInt(id);
}

async function runEvaluation(): Promise<void> {
  if (engineRunning) {
    riskEngineLogger.warn('Risk engine: previous evaluation still running, skipping');
    return;
  }
  engineRunning = true;

  try {
    const locs = await getEnabledLocations();
    // Single instant for the whole tick. Used both for the freshness math in
    // evaluateLocation and for every spatial query — every flash count, every
    // proximity check, every "time since last flash" computation references
    // THIS moment, not whatever Postgres NOW() returns when the per-location
    // SQL happens to execute. That removes the TOCTOU between the freshness
    // snapshot below and the spatial queries below it.
    const tickNow = new Date();
    const timestamp = DateTime.fromJSDate(tickNow).toUTC().toISO()!;
    // Tick-scoped feed-freshness snapshot — see evaluateLocation's
    // preFetchedLatestIngestion argument. One Postgres roundtrip per tick
    // instead of one per location. Recomputed on every tick so an outage
    // mid-evaluation is still caught on the next 60s pass.
    const tickLatestIngestion = await getLatestIngestionTime();
    riskEngineLogger.info(`Risk engine evaluating ${locs.length} location(s)`, { timestamp });

    // Per-org buckets for the EUMETSAT feed-degraded / feed-recovered digest.
    // Without this, an outage flips every location DEGRADED in one tick and
    // each one used to fire its own per-location alert — 50 outage emails
    // and another 50 on recovery for an org with 50 locations. We now skip
    // per-location DEGRADED dispatch and emit ONE org-level email per
    // direction per outage, throttled inside dispatchFeedHealthNotice.
    interface OrgDegradedBucket {
      count: number;
      anchorLocationId: string;
      anchorStateId: bigint;
    }
    const degradedEntries = new Map<string, OrgDegradedBucket>();
    const degradedExits = new Map<string, OrgDegradedBucket>();

    for (const loc of locs) {
      try {
        const result = await evaluateLocation(loc, tickLatestIngestion, tickNow);
        // Snapshot the cold-start state BEFORE we stamp bootstrapped_at —
        // the very first evaluation must suppress alerts even though we're
        // about to mark the location as bootstrapped for future ticks.
        const wasFirstEverEvaluation = !loc.bootstrapped_at;
        const stateId = await logEvaluation(result);
        if (wasFirstEverEvaluation) {
          // Idempotent: no-op on subsequent calls. Done after logEvaluation
          // so we never mark "bootstrapped" without a corresponding
          // risk_states row to point at.
          await markLocationBootstrapped(loc.id);
        }

        const stateChanged = result.newState !== result.previousState;

        // Broadcast on every state change
        if (stateChanged) {
          riskEngineLogger.info(`Location state changed`, {
            locationName: loc.name,
            previousState: result.previousState || 'INIT',
            newState: result.newState,
            reason: result.reason,
          });

          wsManager.broadcastRiskStateChange({
            locationId: result.locationId,
            org_id: loc.org_id,
            locationName: result.locationName,
            newState: result.newState,
            previousState: result.previousState,
            reason: result.reason,
            evaluatedAt: timestamp,
            flashesInStopRadius: result.stopFlashes,
            flashesInPrepareRadius: result.prepareFlashes,
            nearestFlashKm: result.nearestFlashKm,
            isDegraded: result.isDegraded,
          });
        }

        // Bucket DEGRADED entry/exit transitions per org for the post-loop
        // digest — we suppress the per-location dispatch path for DEGRADED
        // so a feed outage produces ONE org email instead of N. Recoveries
        // INTO STOP/HOLD/PREPARE keep their loud per-location alerts (real
        // risk should not be silenced); only the silent DEGRADED→ALL_CLEAR
        // recovery path is captured in the digest.
        if (
          stateChanged &&
          result.newState === 'DEGRADED' &&
          result.previousState !== 'DEGRADED' &&
          !wasFirstEverEvaluation
        ) {
          const cur = degradedEntries.get(loc.org_id) ?? {
            count: 0,
            anchorLocationId: loc.id,
            anchorStateId: stateId,
          };
          cur.count++;
          degradedEntries.set(loc.org_id, cur);
        } else if (
          stateChanged &&
          result.previousState === 'DEGRADED' &&
          result.newState === 'ALL_CLEAR'
        ) {
          const cur = degradedExits.get(loc.org_id) ?? {
            count: 0,
            anchorLocationId: loc.id,
            anchorStateId: stateId,
          };
          cur.count++;
          degradedExits.set(loc.org_id, cur);
        }

        // Alert logic:
        // - Never alert on the very first evaluation (cold start). The marker
        //   is the durable `locations.bootstrapped_at` — a stale in-process
        //   `previousState === null` check could regress across restarts.
        // - STOP/HOLD: alert on state change OR persistence (no alert in last N min)
        //   UNLESS alert_on_change_only=true, in which case only state changes trigger alerts
        // - PREPARE: alert on state change only (no repeat alerts)
        // - DEGRADED: handled out-of-band via the per-org digest above —
        //   intentionally NOT in the per-location alert state list, since
        //   the dispatch path would fan out N×recipients per location.
        const isFirstEver = wasFirstEverEvaluation;
        const isAlertState = ['STOP', 'HOLD', 'PREPARE'].includes(result.newState);
        const supportsPersistenceAlert =
          ['STOP', 'HOLD'].includes(result.newState) && !loc.alert_on_change_only;
        if (!isFirstEver && isAlertState) {
          const recentAlerts = supportsPersistenceAlert
            ? await getRecentAlertsForLocation(result.locationId, loc.persistence_alert_min ?? 10)
            : [];
          const noRecentAlert = recentAlerts.length === 0;
          const shouldAlert = stateChanged || (supportsPersistenceAlert && noRecentAlert);
          if (shouldAlert) {
            riskEngineLogger.info(`Dispatching alert`, {
              locationName: loc.name,
              state: result.newState,
              reason: stateChanged ? 'state_change' : 'persistence',
            });
            // Fire-and-forget: dispatchAlerts internally awaits SMTP + Twilio per
            // recipient. Awaiting it here would serialise the per-location loop
            // behind every notifier round-trip, so a slow SMTP delays evaluation
            // of unrelated locations. dispatchAlerts owns its error handling;
            // this .catch is only a safety net for unhandled rejections.
            dispatchAlerts(result.locationId, stateId, result.newState, result.reason).catch(
              (err) => {
                riskEngineLogger.error('dispatchAlerts unhandled rejection', {
                  locationName: loc.name,
                  state: result.newState,
                  error: (err as Error).message,
                });
              },
            );
          }
        }
      } catch (err) {
        riskEngineLogger.error(`Error evaluating location`, {
          locationName: loc.name,
          error: (err as Error).message,
        });
      }
    }

    // Fire-and-forget the org-level feed-health digests. Throttling lives
    // inside dispatchFeedHealthNotice (alerts-table query against the
    // configured FEED_NOTICE_THROTTLE_MIN window), so calling it on every
    // tick during an outage is safe — only the first call inside the
    // window actually sends.
    for (const [orgId, info] of degradedEntries) {
      dispatchFeedHealthNotice({
        orgId,
        kind: 'degraded',
        anchorLocationId: info.anchorLocationId,
        anchorStateId: Number(info.anchorStateId),
        affectedCount: info.count,
      }).catch((err) => {
        riskEngineLogger.error('dispatchFeedHealthNotice (degraded) failed', {
          orgId,
          error: (err as Error).message,
        });
      });
    }
    for (const [orgId, info] of degradedExits) {
      dispatchFeedHealthNotice({
        orgId,
        kind: 'recovered',
        anchorLocationId: info.anchorLocationId,
        anchorStateId: Number(info.anchorStateId),
        affectedCount: info.count,
      }).catch((err) => {
        riskEngineLogger.error('dispatchFeedHealthNotice (recovered) failed', {
          orgId,
          error: (err as Error).message,
        });
      });
    }

    // Data cleanup runs out-of-band in startLeaderJobs/runRetention (index.ts).
  } catch (err) {
    riskEngineLogger.error('Risk engine error', { error: (err as Error).message });
  } finally {
    engineRunning = false;
  }
}

export function startRiskEngine(intervalSec: number = 60): void {
  riskEngineLogger.info(`Starting risk engine (interval: ${intervalSec}s)`);
  engineStopped = false;

  const scheduleNext = () => {
    if (engineStopped) return;
    engineTimer = setTimeout(async () => {
      engineTimer = null;
      try {
        await runEvaluation();
      } catch (err) {
        riskEngineLogger.error('Scheduled risk engine evaluation failed', {
          error: (err as Error).message,
        });
      } finally {
        scheduleNext();
      }
    }, intervalSec * 1000);
  };

  // Run first evaluation immediately, then chain.
  void (async () => {
    try {
      await runEvaluation();
    } catch (err) {
      riskEngineLogger.error('Initial risk engine evaluation failed', {
        error: (err as Error).message,
      });
    } finally {
      scheduleNext();
    }
  })();
}

export function stopRiskEngine(): void {
  engineStopped = true;
  if (engineTimer) {
    clearTimeout(engineTimer);
    engineTimer = null;
    riskEngineLogger.info('Risk engine stopped');
  }
}

export { evaluateLocation, runEvaluation };

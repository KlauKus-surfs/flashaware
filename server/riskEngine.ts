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
  LocationRecord,
  RiskStateRecord,
} from './queries';
import { dispatchAlerts } from './alertService';
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
}

export function decideRiskState(i: RiskDecisionInputs): { newState: RiskState; reason: string } {
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

  if (i.timeSinceLastFlashMin === null && !i.isDegraded) {
    return {
      newState: 'ALL_CLEAR',
      reason: `No flash records within ${i.stop_radius_km} km. Data feed healthy. Safe to resume operations.`,
    };
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

async function evaluateLocation(location: EngineLocation): Promise<EvaluationResult> {
  const now = DateTime.utc();

  // 1. Data freshness check
  const latestIngestion = await getLatestIngestionTime();
  let dataAgeSec = 9999;
  let isDegraded = false;

  if (latestIngestion) {
    dataAgeSec = Math.floor((now.toMillis() - latestIngestion.getTime()) / 1000);
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
    };
  }

  // 2. Spatial flash queries (PostGIS)
  const centroidWkt = `POINT(${location.lng} ${location.lat})`;

  const [stopFlashes, prepareFlashes, nearestFlashKm, trendData] = await Promise.all([
    countFlashesInRadius(centroidWkt, location.stop_radius_km, location.stop_window_min),
    countFlashesInRadius(centroidWkt, location.prepare_radius_km, location.prepare_window_min),
    getNearestFlashDistance(centroidWkt, location.stop_window_min),
    getFlashTrend(centroidWkt, location.prepare_radius_km),
  ]);

  const currentState = await getCurrentState(location.id);

  // Resolve effective prior state: if currently DEGRADED, look back for last real state
  // so the all-clear wait is honoured on recovery.
  let effectivePriorState: RiskState | null = currentState;
  if (currentState === 'DEGRADED') {
    const lastReal = await getLastNonDegradedState(location.id);
    effectivePriorState = lastReal;
  }

  // 3. Fetch time-since-last-flash only when the no-flashes branch *and* a
  // wait is required (descending from STOP/HOLD/PREPARE). Avoids a DB hit on
  // the hot path where flashes are present.
  const proximityKmCheck = Math.max(1, location.stop_radius_km * 0.5);
  const noStopOrPrepareConditions =
    stopFlashes < location.stop_flash_threshold &&
    !(nearestFlashKm !== null && nearestFlashKm < proximityKmCheck) &&
    prepareFlashes < location.prepare_flash_threshold;
  const needsWait =
    effectivePriorState === 'STOP' ||
    effectivePriorState === 'HOLD' ||
    effectivePriorState === 'PREPARE';
  const timeSinceLastFlashMin =
    noStopOrPrepareConditions && needsWait
      ? await getTimeSinceLastFlashInRadius(
          centroidWkt,
          location.stop_radius_km,
          location.allclear_wait_min,
        )
      : null;

  const decision = decideRiskState({
    stop_radius_km: location.stop_radius_km,
    prepare_radius_km: location.prepare_radius_km,
    stop_flash_threshold: location.stop_flash_threshold,
    stop_window_min: location.stop_window_min,
    prepare_flash_threshold: location.prepare_flash_threshold,
    prepare_window_min: location.prepare_window_min,
    allclear_wait_min: location.allclear_wait_min,
    effectivePriorState,
    isDegraded,
    stopFlashes,
    prepareFlashes,
    nearestFlashKm,
    trend: trendData.trend,
    timeSinceLastFlashMin,
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
      stopFlashes: result.stopFlashes,
      prepareFlashes: result.prepareFlashes,
      nearestFlashKm: result.nearestFlashKm,
      dataAgeSec: result.dataAgeSec,
      trend: result.trend,
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
    const timestamp = DateTime.utc().toISO();
    riskEngineLogger.info(`Risk engine evaluating ${locs.length} location(s)`, { timestamp });

    for (const loc of locs) {
      try {
        const result = await evaluateLocation(loc);
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

        // Alert logic:
        // - Never alert on the very first evaluation (cold start). The marker
        //   is the durable `locations.bootstrapped_at` — a stale in-process
        //   `previousState === null` check could regress across restarts.
        // - STOP/HOLD: alert on state change OR persistence (no alert in last N min)
        //   UNLESS alert_on_change_only=true, in which case only state changes trigger alerts
        // - PREPARE/DEGRADED: alert on state change only (no repeat alerts)
        const isFirstEver = wasFirstEverEvaluation;
        const isAlertState = ['STOP', 'HOLD', 'DEGRADED', 'PREPARE'].includes(result.newState);
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

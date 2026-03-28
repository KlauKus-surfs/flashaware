import { DateTime } from 'luxon';
import {
  getAllLocations,
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
import { riskEngineLogger } from './logger';
import { wsManager } from './websocket';

type RiskState = 'ALL_CLEAR' | 'PREPARE' | 'STOP' | 'HOLD' | 'DEGRADED';

interface EngineLocation {
  id: string;
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
  enabled: boolean;
}

// Helper to convert LocationRecord to EngineLocation and extract coordinates
function locationToEngine(loc: LocationRecord): EngineLocation {
  // Extract coordinates from centroid geometry (PostGIS format)
  // Assuming centroid is stored as POINT(lng lat) in WKT format
  const centroidMatch = loc.centroid.match(/POINT\(([-\d.]+) ([-\d.]+)\)/);
  const lng = centroidMatch ? parseFloat(centroidMatch[1]) : 0;
  const lat = centroidMatch ? parseFloat(centroidMatch[2]) : 0;

  return {
    id: loc.id,
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
    enabled: loc.enabled,
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

let engineRunning = false;
let engineInterval: ReturnType<typeof setInterval> | null = null;

async function getEnabledLocations(): Promise<EngineLocation[]> {
  const locations = await getAllLocations();
  return locations.filter(l => l.enabled).map(locationToEngine);
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

  // 3. State determination (priority order)
  let newState: RiskState;
  let reason: string;

  if (stopFlashes >= location.stop_flash_threshold || (nearestFlashKm !== null && nearestFlashKm < 5)) {
    newState = 'STOP';
    const parts: string[] = [];
    if (stopFlashes >= location.stop_flash_threshold) {
      parts.push(`${stopFlashes} flash(es) within ${location.stop_radius_km} km in last ${location.stop_window_min} min`);
    }
    if (nearestFlashKm !== null && nearestFlashKm < 5) {
      parts.push(`nearest flash at ${nearestFlashKm.toFixed(1)} km (< 5 km threshold)`);
    }
    reason = parts.join('; ') + `. Trend: ${trendData.trend}.`;
  } else if (prepareFlashes >= location.prepare_flash_threshold) {
    if (effectivePriorState === 'STOP' || effectivePriorState === 'HOLD') {
      newState = 'HOLD';
      reason = `${prepareFlashes} flash(es) within ${location.prepare_radius_km} km in last ${location.prepare_window_min} min. STOP conditions no longer met but threat persists. Trend: ${trendData.trend}.`;
    } else {
      newState = 'PREPARE';
      reason = `${prepareFlashes} flash(es) within ${location.prepare_radius_km} km in last ${location.prepare_window_min} min. Trend: ${trendData.trend}.`;
    }
  } else {
    // No flashes in either radius — determine if we can clear
    // Must honour allclear_wait_min when coming down from STOP, HOLD, or PREPARE
    const needsWait = effectivePriorState === 'STOP' || effectivePriorState === 'HOLD' || effectivePriorState === 'PREPARE';
    if (needsWait) {
      const timeSinceLastFlash = await getTimeSinceLastFlashInRadius(centroidWkt, location.stop_radius_km, location.allclear_wait_min);
      if (timeSinceLastFlash === null && !isDegraded) {
        // No flash history in stop radius at all — safe to clear immediately
        newState = 'ALL_CLEAR';
        reason = `No flash records within ${location.stop_radius_km} km. Data feed healthy. Safe to resume operations.`;
      } else if (
        timeSinceLastFlash !== null &&
        timeSinceLastFlash >= location.allclear_wait_min &&
        !isDegraded
      ) {
        newState = 'ALL_CLEAR';
        reason = `No flashes within ${location.stop_radius_km} km for ${timeSinceLastFlash.toFixed(0)} min (≥ ${location.allclear_wait_min} min threshold). Safe to resume operations.`;
      } else {
        // Coming down from PREPARE stays as PREPARE during wait, STOP/HOLD stays as HOLD
        newState = (effectivePriorState === 'PREPARE') ? 'PREPARE' : 'HOLD';
        const waitRemaining = timeSinceLastFlash !== null
          ? Math.max(0, location.allclear_wait_min - timeSinceLastFlash)
          : location.allclear_wait_min;
        const waitLabel = newState === 'PREPARE'
          ? `Threat reducing but ALL CLEAR criteria not yet met. ${Math.ceil(waitRemaining)} min remaining. Stay alert.`
          : `No active threat but ALL CLEAR criteria not yet met. ${Math.ceil(waitRemaining)} min remaining. Stay sheltered.`;
        reason = waitLabel;
      }
    } else {
      newState = 'ALL_CLEAR';
      reason = `No flashes within ${location.prepare_radius_km} km in last ${location.prepare_window_min} min. Data feed healthy.`;
    }
  }

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
        const stateId = await logEvaluation(result);

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
        // - Never alert on the very first evaluation (previousState=null = cold start)
        // - STOP/HOLD: alert on state change OR persistence (no alert in last 10 min)
        // - PREPARE/DEGRADED: alert on state change only (no repeat alerts)
        const isFirstEver = result.previousState === null;
        const isAlertState = ['STOP', 'HOLD', 'DEGRADED', 'PREPARE'].includes(result.newState);
        const supportsPersistenceAlert = ['STOP', 'HOLD'].includes(result.newState);
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
            await dispatchAlerts(result.locationId, stateId, result.newState, result.reason);
          }
        }
      } catch (err) {
        riskEngineLogger.error(`Error evaluating location`, {
          locationName: loc.name,
          error: (err as Error).message,
        });
      }
    }

    // Data cleanup is now handled by the database retention policies
    // and the pruneOldData function in queries.ts
  } catch (err) {
    riskEngineLogger.error('Risk engine error', { error: (err as Error).message });
  } finally {
    engineRunning = false;
  }
}

export function startRiskEngine(intervalSec: number = 60): void {
  riskEngineLogger.info(`Starting risk engine (interval: ${intervalSec}s)`);
  
  // Run first evaluation immediately
  runEvaluation().catch(err => {
    riskEngineLogger.error('Initial risk engine evaluation failed', { error: err.message });
  });
  
  // Schedule periodic evaluations
  engineInterval = setInterval(() => {
    runEvaluation().catch(err => {
      riskEngineLogger.error('Scheduled risk engine evaluation failed', { error: err.message });
    });
  }, intervalSec * 1000);
}

export function stopRiskEngine(): void {
  if (engineInterval) {
    clearInterval(engineInterval);
    engineInterval = null;
    riskEngineLogger.info('Risk engine stopped');
  }
}

export { evaluateLocation, runEvaluation };

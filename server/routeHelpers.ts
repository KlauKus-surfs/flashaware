// Shared helpers used by route modules. Pulled out of the old monolithic
// index.ts so route files can import them without depending on each other.
//
// All helpers are pure or thin DB wrappers — no Express side effects.
import { canAccessLocation } from './authScope';
import { getLocationById } from './queries';

export const VALID_RISK_STATES = new Set(['STOP', 'PREPARE', 'HOLD', 'ALL_CLEAR', 'DEGRADED']);

/**
 * Fetch a location only if the caller is allowed to see it. Super-admins can
 * reach any org; everyone else is locked to their own. Returns null on miss
 * (callers should respond 404 so we never leak existence to other tenants).
 */
export async function getLocationForUser(
  id: string,
  user: { role: string; org_id: string },
) {
  const loc = await getLocationById(id);
  return canAccessLocation(loc, user) ? loc : null;
}

/**
 * Defensive parser for the `notify_states` field on recipient create/update.
 * Returns a clean Partial<Record<RiskState, boolean>> with only valid keys
 * and boolean values, or null if the input is absent/invalid (caller treats
 * null as "do not write this column", letting the DB default win).
 *
 * NOTE: this does *not* validate that at least one state is true — that check
 * happens in assertNotifyStatesNotAllOff so the route returns a clear 400
 * instead of silently dropping the input.
 */
export function sanitizeNotifyStates(input: unknown): Record<string, boolean> | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) return null;
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (VALID_RISK_STATES.has(k) && typeof v === 'boolean') {
      out[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Returns an error message if `notify_states` was provided and explicitly
 * disables every state (silent recipient), else null. Defaults — i.e. omitted
 * keys — are treated as `true` (subscribed), so a partial map with all
 * provided values false but other keys missing is still considered active.
 */
export function assertNotifyStatesNotAllOff(states: Record<string, boolean> | null): string | null {
  if (!states) return null;
  const provided = Object.entries(states);
  if (provided.length === 0) return null;
  if (provided.length === VALID_RISK_STATES.size && provided.every(([, v]) => v === false)) {
    return 'notify_states cannot disable every alert state — recipient would never be notified';
  }
  return null;
}

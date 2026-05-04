import { DateTime } from 'luxon';

// Default operations TZ (the product is South Africa-centric), used when the
// caller hasn't expressed a preference and as the suffix label. Operators on
// other continents see times in their own zone with the suffix updated to
// reflect that — previously every timestamp was rendered as if every operator
// was in Johannesburg, regardless of where they actually were.
const DEFAULT_ZONE = 'Africa/Johannesburg';

// Resolve the viewer's display zone. localStorage override wins so an
// operator can pin to "ops time" (e.g. site is in JNB but operator is in
// London and prefers SAST for log alignment); otherwise we honour the
// browser's TZ. Falling back to DEFAULT_ZONE keeps SSR / older browsers
// rendering something stable.
export function getDisplayZone(): string {
  try {
    const override = localStorage.getItem('flashaware_display_zone');
    if (override) return override;
  } catch {
    /* localStorage may be unavailable (private mode, SSR) */
  }
  try {
    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (browserZone) return browserZone;
  } catch {
    /* Intl unavailable on very old runtimes */
  }
  return DEFAULT_ZONE;
}

export function setDisplayZone(zone: string | null): void {
  try {
    if (zone) localStorage.setItem('flashaware_display_zone', zone);
    else localStorage.removeItem('flashaware_display_zone');
  } catch {
    /* ignore — non-critical setting */
  }
}

// Short label suffix users see on every timestamp. Always derived from the
// active zone so a London operator who clicks "Acknowledged at 14:32 GMT"
// gets a label that matches reality, not "SAST" from a hard-coded constant.
export function displayZoneLabel(at: string | Date | null | undefined = new Date()): string {
  const zone = getDisplayZone();
  const dt =
    typeof at === 'string'
      ? DateTime.fromISO(at, { zone: 'utc' }).setZone(zone)
      : at instanceof Date
        ? DateTime.fromJSDate(at).setZone(zone)
        : DateTime.now().setZone(zone);
  return dt.toFormat('ZZZZ'); // e.g. "SAST", "GMT", "EDT"
}

export type SastFormat = 'time' | 'short' | 'full' | 'iso';

/**
 * Format a UTC ISO timestamp for display. The function name is kept for
 * backwards compatibility with hundreds of call sites that read like
 * `formatSAST(t) + ' SAST'`, but the zone is the viewer's preferred display
 * zone (browser default, or a localStorage override). Use `displayZoneLabel()`
 * alongside this if you need the matching suffix label.
 */
export function formatSAST(utcStr: string | null | undefined, fmt: SastFormat = 'short'): string {
  if (!utcStr) return '—';
  const zone = getDisplayZone();
  const dt = DateTime.fromISO(utcStr, { zone: 'utc' }).setZone(zone);
  if (!dt.isValid) return '—';
  switch (fmt) {
    case 'time':
      return dt.toFormat('HH:mm:ss');
    case 'short':
      return dt.toFormat('HH:mm:ss dd LLL');
    case 'full':
      return dt.toFormat('yyyy-MM-dd HH:mm:ss');
    case 'iso':
      return dt.toISO() ?? '—';
  }
}

export function timeAgo(utcStr: string | null | undefined): string {
  if (!utcStr) return '—';
  const diff = DateTime.utc().diff(DateTime.fromISO(utcStr, { zone: 'utc' }), [
    'minutes',
    'seconds',
  ]);
  if (diff.minutes > 0) return `${Math.floor(diff.minutes)}m ${Math.floor(diff.seconds % 60)}s ago`;
  return `${Math.floor(diff.seconds)}s ago`;
}

export function nowSAST(): string {
  return DateTime.utc().setZone(getDisplayZone()).toFormat('HH:mm:ss');
}

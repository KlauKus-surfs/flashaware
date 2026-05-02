import { DateTime } from 'luxon';

const ZONE = 'Africa/Johannesburg';

export type SastFormat = 'time' | 'short' | 'full' | 'iso';

export function formatSAST(utcStr: string | null | undefined, fmt: SastFormat = 'short'): string {
  if (!utcStr) return '—';
  const dt = DateTime.fromISO(utcStr, { zone: 'utc' }).setZone(ZONE);
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
  return DateTime.utc().setZone(ZONE).toFormat('HH:mm:ss');
}

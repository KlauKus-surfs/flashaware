// MIRROR FILE — keep in sync with server/validators.ts (and shared/validators.ts).
// Cross-package imports were ruled out because the server's Dockerfile builds
// from the server/ directory only. The validators are pure regex helpers, ~25
// lines total; duplication is cheaper than reshaping the build. The
// server-side validators.test.ts asserts the two copies match byte-for-byte.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidEmail(s: unknown): s is string {
  return typeof s === 'string' && s.length <= 254 && EMAIL_RE.test(s.trim());
}

// E.164: leading +, country code 1-9, then 1-14 more digits. Max 15 digits total.
const E164_RE = /^\+[1-9]\d{1,14}$/;
export function isValidE164(s: unknown): s is string {
  return typeof s === 'string' && E164_RE.test(s.trim());
}

export function isFiniteNum(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}

export { EMAIL_RE, E164_RE };

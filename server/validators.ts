// Shared input validators. Extracted from index.ts so test code can import
// them without dragging the whole HTTP server (and its side effects) along.

// RFC 5322 lite — good enough to reject obvious garbage without false-rejecting valid addresses.
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

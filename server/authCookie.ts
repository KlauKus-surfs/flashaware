import { Request, Response } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

// ---------------------------------------------------------------------------
// HttpOnly auth cookie + double-submit CSRF token. Replaces the previous
// "JWT in localStorage" posture, which was open to a single XSS exfil.
//
// Two cookies are issued at login time:
//   * `fa_auth`   — httpOnly, signed JWT, NOT readable from JS.
//   * `fa_csrf`   — readable (httpOnly=false), random per-session token.
//
// Mutating requests must echo `fa_csrf` back via the `X-CSRF-Token` header.
// The middleware checks the two are equal in constant time. Same-site
// cookies make the basic CSRF surface narrow; the double-submit pattern
// closes the residual same-origin XSS-via-script attack against a forged
// fetch (script can read `fa_csrf` and copy it but cannot read `fa_auth`,
// so a token-stealing XSS becomes a session-bound action only).
// ---------------------------------------------------------------------------

export const AUTH_COOKIE = 'fa_auth';
export const CSRF_COOKIE = 'fa_csrf';
export const CSRF_HEADER = 'x-csrf-token';

// 8-hour session aligns with JWT_EXPIRES_IN's default.
const COOKIE_MAX_AGE_MS = 8 * 60 * 60 * 1000;

function isProd(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function generateCsrfToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Set both cookies on the response. Called from /api/auth/login after the
 * JWT is issued. The cookies use the same TTL as the JWT so refresh policy
 * stays in one place.
 */
export function setAuthCookies(res: Response, jwt: string, csrf: string): void {
  res.cookie(AUTH_COOKIE, jwt, {
    httpOnly: true,
    secure: isProd(),
    sameSite: isProd() ? 'lax' : 'lax',
    maxAge: COOKIE_MAX_AGE_MS,
    path: '/',
  });
  res.cookie(CSRF_COOKIE, csrf, {
    httpOnly: false, // readable so the SPA can echo it in X-CSRF-Token
    secure: isProd(),
    sameSite: isProd() ? 'lax' : 'lax',
    maxAge: COOKIE_MAX_AGE_MS,
    path: '/',
  });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(AUTH_COOKIE, { path: '/' });
  res.clearCookie(CSRF_COOKIE, { path: '/' });
}

/**
 * Read the auth cookie off a request, if present. Returns the raw JWT or
 * null. The cookie name is not URL-decoded by cookie-parser; cookie-parser
 * already does that.
 */
export function readAuthCookie(req: Request): string | null {
  const c = (req as any).cookies?.[AUTH_COOKIE];
  return typeof c === 'string' && c.length > 0 ? c : null;
}

/**
 * CSRF check for mutating endpoints. Constant-time compare of the cookie
 * value vs the X-CSRF-Token header. Returns null if OK, or an error string
 * describing the failure reason. The endpoint can keep its own error shape;
 * we just say yes/no.
 *
 * Skipped for requests that don't carry the auth cookie — those are
 * authenticated via the legacy Authorization header (test runners, mobile
 * clients, server-to-server). Only browser sessions need CSRF protection.
 */
export function verifyCsrf(req: Request): string | null {
  if (!readAuthCookie(req)) return null; // header-auth path is exempt
  const cookie = (req as any).cookies?.[CSRF_COOKIE];
  const header = req.headers[CSRF_HEADER];
  if (typeof cookie !== 'string' || cookie.length === 0) return 'missing csrf cookie';
  if (typeof header !== 'string' || header.length === 0) return 'missing csrf header';
  const a = Buffer.from(cookie);
  const b = Buffer.from(header);
  if (a.length !== b.length) return 'csrf mismatch';
  if (!timingSafeEqual(a, b)) return 'csrf mismatch';
  return null;
}

/**
 * Express middleware wrapper. Apply to mutating routes that issue cookies.
 * Read-only / Bearer-only / public routes do not need this.
 */
export function requireCsrf(req: Request, res: Response, next: () => void): void {
  const err = verifyCsrf(req);
  if (err) {
    res.status(403).json({ error: 'CSRF check failed', detail: err });
    return;
  }
  next();
}

// HMAC helper kept available for future signed-cookie use cases.
export function hmac(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

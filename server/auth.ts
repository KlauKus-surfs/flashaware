import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import { findUserByEmail } from './queries';
import { authLogger } from './logger';
import { setRequestUser } from './middleware/requestId';
import { readAuthCookie } from './authCookie';

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';

// Validate JWT_SECRET on startup
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable must be set');
}
if (JWT_SECRET === 'change-me-to-a-random-secret-in-production') {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be changed from the default value in production');
  }
  // In development, warn but allow startup
  console.warn(
    '[AUTH] WARNING: JWT_SECRET is using the default placeholder value. Change it before deploying to production.',
  );
}

authLogger.info('JWT configuration validated');

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: 'super_admin' | 'admin' | 'operator' | 'viewer';
  org_id: string;
  // Populated on the login response so the client can show "Acme Corp" in the
  // avatar menu without an extra fetch. Not signed into the JWT — we keep the
  // token lean and tolerate org renames without forcing reauth.
  org_name?: string;
  // Set on the login response (not in the JWT) when the user authenticated
  // with one of BANNED_PASSWORDS — i.e. the seeded `admin123` shipped with
  // the demo super-admin. The client surfaces this as a forced
  // "Change password before continuing" dialog so the well-known credential
  // doesn't survive past the operator's first sign-in.
  must_change_password?: boolean;
}

// Well-known seeded / placeholder passwords that the API refuses to accept on
// account creation or rotation, and flags on login so the client can force a
// rotation flow. Kept here (not in env) so the list can never be silently
// emptied by an env-var typo. All comparisons are case-insensitive.
export const BANNED_PASSWORDS: readonly string[] = [
  'admin123', // seeded with SEED_DEMO_ADMIN — the original footgun
  'password',
  'password1',
  'changeme',
  'letmein',
];

export function isBannedPassword(password: string): boolean {
  return BANNED_PASSWORDS.some((p) => p.toLowerCase() === password.toLowerCase());
}

// Server-enforced minimum password length. Higher than the legacy 6-char floor
// hard-coded in a few zod schemas; centralised here so every entry point lands
// on the same rule. Update tests/uxFixes.test.ts if this constant changes.
export const MIN_PASSWORD_LENGTH = 12;

export interface PasswordRejection {
  ok: false;
  error: string;
}
export interface PasswordAccepted {
  ok: true;
}
export type PasswordValidation = PasswordAccepted | PasswordRejection;

/**
 * Single source of truth for password acceptance: combines the length floor
 * with the well-known-default block list. Returns a discriminated result so
 * callers can surface the exact error verbatim.
 */
export function validatePassword(password: unknown): PasswordValidation {
  if (typeof password !== 'string') {
    return { ok: false, error: 'Password is required' };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  if (isBannedPassword(password)) {
    return {
      ok: false,
      error: 'That password is on the well-known-default block list. Pick something unique.',
    };
  }
  return { ok: true };
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

export function generateToken(user: AuthUser): string {
  const payload = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    org_id: user.org_id,
  };
  const options: jwt.SignOptions = { expiresIn: JWT_EXPIRES_IN as any };
  return jwt.sign(payload, JWT_SECRET as jwt.Secret, options);
}

export async function login(
  email: string,
  password: string,
): Promise<{ token: string; user: AuthUser } | null> {
  try {
    const row = await findUserByEmail(email);
    if (!row) {
      authLogger.warn('Login attempt with non-existent email', { email });
      return null;
    }

    const valid = await bcrypt.compare(password, row.password_hash);
    if (!valid) {
      authLogger.warn('Login attempt with invalid password', { email, userId: row.id });
      return null;
    }

    // Reject login if the user's org has been soft-deleted. This blocks access
    // immediately when a tenant is removed, even before retention hard-deletes
    // their rows.
    const { getOne } = await import('./db');
    const org = await getOne<{ name: string; deleted_at: string | null }>(
      'SELECT name, deleted_at FROM organisations WHERE id = $1',
      [row.org_id],
    );
    if (org?.deleted_at) {
      authLogger.warn('Login blocked — organisation is deleted', {
        email,
        userId: row.id,
        orgId: row.org_id,
      });
      return null;
    }

    const mustChangePassword = isBannedPassword(password);
    const user: AuthUser = {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      org_id: row.org_id,
      org_name: org?.name,
      // Surfaced to the client so the UI can immediately open the
      // change-password dialog. Intentionally NOT signed into the JWT —
      // a stolen token shouldn't carry "and please rotate" baggage.
      must_change_password: mustChangePassword || undefined,
    };
    const token = generateToken(user);

    authLogger.info('User logged in successfully', {
      userId: user.id,
      email: user.email,
      role: user.role,
      mustChangePassword,
    });
    return { token, user };
  } catch (error) {
    authLogger.error('Login error', { email, error: (error as Error).message });
    return null;
  }
}

// bcrypt work factor. 2026 baseline is 12 — cost 10 is ~10× faster on modern
// hardware and was a 2010-era recommendation. Verification of pre-existing
// hashes (which were created with cost 10) still works because bcrypt encodes
// the cost into the hash itself; re-hashing on next successful login is a
// nice-to-have that we explicitly skip to keep this change isolated.
const BCRYPT_COST = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

// Per-process cache of "this user.id is still a valid principal" so the
// per-request DB recheck below doesn't fire on every API call. TTL is short
// enough that a delete on another instance becomes visible within ~5s
// (instead of the previous 30s); the userRoutes/orgRoutes mutators also
// call invalidateAuthCache() so revocation feels instant on the active
// instance. Multi-machine note: invalidateAuthCache is per-process, so a
// delete on machine A only drops the entry on A; B picks up the revocation
// at the next TTL expiry. Keeping the TTL low is the simplest fix for the
// fan-out case without introducing a Redis dependency in auth.
const AUTH_RECHECK_TTL_MS = 5_000;
const authRecheckCache = new Map<string, number>(); // userId → expiresAt (ms)

export function invalidateAuthCache(userId?: string): void {
  if (userId) authRecheckCache.delete(userId);
  else authRecheckCache.clear();
}

// Middleware: require valid JWT.
//
// JWTs live for ~8h, so without a server-side recheck a deleted user (or one
// whose org was soft-deleted) would keep API access for the rest of the
// token's lifetime. We do a small DB lookup per request, but cache the result
// for AUTH_RECHECK_TTL_MS to keep the hot path cheap. Mutators that revoke
// access call invalidateAuthCache() to drop a specific user immediately.
export async function authenticate(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Two paths to the JWT:
  //   1. httpOnly auth cookie — the modern browser path. Set by
  //      /api/auth/login; not readable from JS, so XSS can't exfiltrate it.
  //   2. Authorization: Bearer <jwt> — the legacy / programmatic path.
  //      Tests, mobile clients, and server-to-server callers use this.
  // Cookie wins when both are present so a stale Bearer token from
  // localStorage during the migration can't outrank a fresh cookie session.
  const cookieToken = readAuthCookie(req);
  const header = req.headers.authorization;
  let token: string | null = null;
  if (cookieToken) token = cookieToken;
  else if (header?.startsWith('Bearer ')) token = header.slice(7);

  if (!token) {
    authLogger.warn('Missing or invalid Authorization header', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
    });
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  let decoded: AuthUser;
  try {
    decoded = jwt.verify(token, JWT_SECRET!) as unknown as AuthUser;
  } catch (error) {
    authLogger.warn('Invalid or expired token', {
      error: (error as Error).message,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
    });
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  const cachedUntil = authRecheckCache.get(decoded.id);
  if (cachedUntil && cachedUntil > Date.now()) {
    req.user = decoded;
    next();
    return;
  }

  try {
    const { getOne } = await import('./db');
    const row = await getOne<{ id: string }>(
      `SELECT u.id FROM users u
         INNER JOIN organisations o ON o.id = u.org_id AND o.deleted_at IS NULL
         WHERE u.id = $1`,
      [decoded.id],
    );
    if (!row) {
      authRecheckCache.delete(decoded.id);
      authLogger.warn('Token rejected — user no longer exists or org deleted', {
        userId: decoded.id,
        orgId: decoded.org_id,
        ip: req.ip,
      });
      res.status(401).json({ error: 'Account no longer active' });
      return;
    }
    authRecheckCache.set(decoded.id, Date.now() + AUTH_RECHECK_TTL_MS);
  } catch (error) {
    authLogger.error('Auth recheck DB error', { error: (error as Error).message });
    res.status(500).json({ error: 'Authentication check failed' });
    return;
  }

  req.user = decoded;
  // Surface the authenticated principal in the request-scoped log context so
  // every downstream log line picks up `userId` without callers threading it
  // through. requestIdMiddleware established the AsyncLocalStorage scope.
  setRequestUser(decoded.id);
  next();
}

// Middleware: require minimum role
export function requireRole(...roles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      authLogger.warn('Role check failed: user not authenticated', {
        ip: req.ip,
        requiredRoles: roles,
      });
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const hierarchy: Record<string, number> = { super_admin: 4, admin: 3, operator: 2, viewer: 1 };
    const userLevel = hierarchy[req.user.role] || 0;
    const requiredLevel = Math.min(...roles.map((r) => hierarchy[r] || 99));
    if (userLevel < requiredLevel) {
      authLogger.warn('Role check failed: insufficient permissions', {
        userId: req.user.id,
        userRole: req.user.role,
        requiredRoles: roles,
        ip: req.ip,
      });
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}

// Rate limiting middleware for login endpoint
export const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // limit each IP to 20 login attempts per window
  message: { error: 'Too many login attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    authLogger.warn('Login rate limit exceeded', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
    });
    res.status(429).json({ error: 'Too many login attempts, please try again later' });
  },
});

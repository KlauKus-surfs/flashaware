import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import { findUserByEmail } from './queries';
import { authLogger } from './logger';

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
  console.warn('[AUTH] WARNING: JWT_SECRET is using the default placeholder value. Change it before deploying to production.');
}

authLogger.info('JWT configuration validated');

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: 'super_admin' | 'admin' | 'operator' | 'viewer';
  org_id: string;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

export function generateToken(user: AuthUser): string {
  const payload = { id: user.id, email: user.email, name: user.name, role: user.role, org_id: user.org_id };
  const options: jwt.SignOptions = { expiresIn: JWT_EXPIRES_IN as any };
  return jwt.sign(payload, JWT_SECRET as jwt.Secret, options);
}

export async function login(email: string, password: string): Promise<{ token: string; user: AuthUser } | null> {
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
    const org = await getOne<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM organisations WHERE id = $1',
      [row.org_id]
    );
    if (org?.deleted_at) {
      authLogger.warn('Login blocked — organisation is deleted', { email, userId: row.id, orgId: row.org_id });
      return null;
    }

    const user: AuthUser = { id: row.id, email: row.email, name: row.name, role: row.role, org_id: row.org_id };
    const token = generateToken(user);

    authLogger.info('User logged in successfully', { userId: user.id, email: user.email, role: user.role });
    return { token, user };
  } catch (error) {
    authLogger.error('Login error', { email, error: (error as Error).message });
    return null;
  }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

// Middleware: require valid JWT
export function authenticate(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    authLogger.warn('Missing or invalid Authorization header', { 
      ip: req.ip, 
      userAgent: req.get('User-Agent') 
    });
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  try {
    const decoded = jwt.verify(header.slice(7), JWT_SECRET!) as unknown as AuthUser;
    req.user = decoded;
    next();
  } catch (error) {
    authLogger.warn('Invalid or expired token', { 
      error: (error as Error).message,
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Middleware: require minimum role
export function requireRole(...roles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      authLogger.warn('Role check failed: user not authenticated', { 
        ip: req.ip,
        requiredRoles: roles 
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
        ip: req.ip
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
      userAgent: req.get('User-Agent')
    });
    res.status(429).json({ error: 'Too many login attempts, please try again later' });
  }
});

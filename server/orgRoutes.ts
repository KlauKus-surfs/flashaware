import { Router, Response } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { query, getOne, getMany } from './db';
import { authenticate, requireRole, AuthRequest } from './auth';
import { createUser } from './queries';
import { hashPassword } from './auth';
import { logger } from './logger';

const router = Router();

// ============================================================
// Org management — super_admin only
// ============================================================

const createOrgSchema = z.object({
  name: z.string().min(1, 'Organisation name is required'),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
});

// GET /api/orgs — list all orgs (super_admin only)
router.get('/', authenticate, requireRole('super_admin'), async (_req: AuthRequest, res: Response) => {
  try {
    const orgs = await getMany<{ id: string; name: string; slug: string; created_at: string }>(
      `SELECT o.id, o.name, o.slug, o.created_at,
              COUNT(DISTINCT u.id)::int AS user_count,
              COUNT(DISTINCT l.id)::int AS location_count
       FROM organisations o
       LEFT JOIN users u ON u.org_id = o.id
       LEFT JOIN locations l ON l.org_id = o.id
       GROUP BY o.id ORDER BY o.created_at DESC`
    );
    res.json(orgs);
  } catch (error) {
    logger.error('Failed to list orgs', { error: (error as Error).message });
    res.status(500).json({ error: 'Failed to list organisations' });
  }
});

// POST /api/orgs — create a new org (super_admin only)
router.post('/', authenticate, requireRole('super_admin'), async (req: AuthRequest, res: Response) => {
  try {
    const { name, slug } = createOrgSchema.parse(req.body);

    const existing = await getOne<{ id: string }>('SELECT id FROM organisations WHERE slug = $1', [slug]);
    if (existing) return res.status(409).json({ error: 'An organisation with this slug already exists' });

    const org = await getOne<{ id: string; name: string; slug: string; created_at: string }>(
      `INSERT INTO organisations (name, slug) VALUES ($1, $2) RETURNING *`,
      [name, slug]
    );

    logger.info('Organisation created', { orgId: org!.id, name, by: req.user?.id });
    res.status(201).json(org);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: error.errors.map(e => ({ field: e.path.join('.'), message: e.message })) });
    }
    logger.error('Failed to create org', { error: (error as Error).message });
    res.status(500).json({ error: 'Failed to create organisation' });
  }
});

// ============================================================
// Invite tokens
// ============================================================

const createInviteSchema = z.object({
  org_id: z.string().uuid(),
  role: z.enum(['admin', 'operator', 'viewer']).default('viewer'),
  email: z.string().email().optional(),
});

const registerSchema = z.object({
  token: z.string().min(1),
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

// POST /api/orgs/invites — generate an invite link (admin or super_admin)
router.post('/invites', authenticate, requireRole('admin'), async (req: AuthRequest, res: Response) => {
  try {
    const { org_id, role, email } = createInviteSchema.parse(req.body);

    // Admins can only invite into their own org; super_admin can invite into any org
    const callerOrgId = req.user!.org_id;
    if (req.user!.role !== 'super_admin' && org_id !== callerOrgId) {
      return res.status(403).json({ error: 'You can only create invites for your own organisation' });
    }

    const org = await getOne<{ id: string; name: string }>('SELECT id, name FROM organisations WHERE id = $1', [org_id]);
    if (!org) return res.status(404).json({ error: 'Organisation not found' });

    const token = crypto.randomBytes(32).toString('hex');

    await query(
      `INSERT INTO invite_tokens (token, org_id, role, email) VALUES ($1, $2, $3, $4)`,
      [token, org_id, role, email || null]
    );

    logger.info('Invite token created', { orgId: org_id, role, by: req.user?.id });

    const baseUrl = process.env.APP_URL || 'https://flashaware.com';
    res.status(201).json({
      token,
      invite_url: `${baseUrl}/register?token=${token}`,
      org_name: org.name,
      role,
      expires_in: '7 days',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: error.errors.map(e => ({ field: e.path.join('.'), message: e.message })) });
    }
    logger.error('Failed to create invite', { error: (error as Error).message });
    res.status(500).json({ error: 'Failed to create invite' });
  }
});

// GET /api/orgs/invites — list pending invites for the caller's org (admin only)
router.get('/invites', authenticate, requireRole('admin'), async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.role === 'super_admin' ? undefined : req.user!.org_id;
    const invites = orgId
      ? await getMany(
          `SELECT i.id, i.token, i.org_id, o.name AS org_name, i.role, i.email, i.used_at, i.expires_at, i.created_at
           FROM invite_tokens i JOIN organisations o ON o.id = i.org_id
           WHERE i.org_id = $1 ORDER BY i.created_at DESC`,
          [orgId]
        )
      : await getMany(
          `SELECT i.id, i.token, i.org_id, o.name AS org_name, i.role, i.email, i.used_at, i.expires_at, i.created_at
           FROM invite_tokens i JOIN organisations o ON o.id = i.org_id
           ORDER BY i.created_at DESC`
        );
    res.json(invites);
  } catch (error) {
    logger.error('Failed to list invites', { error: (error as Error).message });
    res.status(500).json({ error: 'Failed to list invites' });
  }
});

// GET /api/orgs/invites/:token/validate — check if an invite token is valid (public)
router.get('/invites/:token/validate', async (req, res: Response) => {
  try {
    const invite = await getOne<{
      id: string; org_id: string; role: string; email: string | null;
      used_at: string | null; expires_at: string;
    }>(
      `SELECT i.id, i.org_id, i.role, i.email, i.used_at, i.expires_at, o.name AS org_name
       FROM invite_tokens i JOIN organisations o ON o.id = i.org_id
       WHERE i.token = $1`,
      [req.params.token]
    );

    if (!invite) return res.status(404).json({ error: 'Invalid invite token' });
    if (invite.used_at) return res.status(410).json({ error: 'This invite has already been used' });
    if (new Date(invite.expires_at) < new Date()) return res.status(410).json({ error: 'This invite has expired' });

    res.json({ valid: true, role: invite.role, email: invite.email, org_name: (invite as any).org_name });
  } catch (error) {
    logger.error('Failed to validate invite', { error: (error as Error).message });
    res.status(500).json({ error: 'Failed to validate invite' });
  }
});

// POST /api/orgs/register — register a new user via invite token (public)
router.post('/register', async (req, res: Response) => {
  try {
    const { token, name, email, password } = registerSchema.parse(req.body);

    const invite = await getOne<{
      id: string; org_id: string; role: string; email: string | null;
      used_at: string | null; expires_at: string;
    }>(
      `SELECT * FROM invite_tokens WHERE token = $1`,
      [token]
    );

    if (!invite) return res.status(404).json({ error: 'Invalid invite token' });
    if (invite.used_at) return res.status(410).json({ error: 'This invite has already been used' });
    if (new Date(invite.expires_at) < new Date()) return res.status(410).json({ error: 'This invite has expired' });

    // If invite was locked to a specific email, enforce it
    if (invite.email && invite.email.toLowerCase() !== email.toLowerCase()) {
      return res.status(403).json({ error: 'This invite was sent to a different email address' });
    }

    // Check email not already taken
    const existing = await getOne<{ id: string }>('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

    const hashedPw = await hashPassword(password);
    const newUser = await createUser({
      email: email.toLowerCase(),
      password: hashedPw,
      name,
      role: invite.role as 'admin' | 'operator' | 'viewer',
      org_id: invite.org_id,
    });

    // Mark token as used
    await query(`UPDATE invite_tokens SET used_at = NOW() WHERE id = $1`, [invite.id]);

    logger.info('User registered via invite', { userId: newUser.id, orgId: invite.org_id, role: invite.role });

    const { password_hash, ...safeUser } = newUser;
    res.status(201).json({ user: safeUser, message: 'Account created successfully. You can now log in.' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: error.errors.map(e => ({ field: e.path.join('.'), message: e.message })) });
    }
    logger.error('Failed to register via invite', { error: (error as Error).message });
    res.status(500).json({ error: 'Failed to create account' });
  }
});

export default router;

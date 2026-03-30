import crypto from 'crypto';
import { z } from 'zod';
import { Router, Request, Response } from 'express';
import { pool, query, getOne, getMany } from './db';
import { authenticate, requireRole, AuthRequest } from './auth';
import { createUser, getAllUsers } from './queries';
import { logger } from './logger';
import { getTransporter } from './alertService';

const router = Router();

// ============================================================
// Org management — super_admin only
// ============================================================

const createOrgSchema = z.object({
  name: z.string().min(1, 'Organisation name is required'),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  invite_email: z.string().email('Invalid email').optional(),
});

function normalizeEmail(email?: string | null): string | null {
  if (!email) return null;
  return email.trim().toLowerCase();
}

function formatRole(role: string): string {
  return role.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function isInviteEmailConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getAppBaseUrl(req: Request): string {
  const configuredUrl = process.env.APP_URL?.trim();
  if (configuredUrl) return configuredUrl.replace(/\/+$/, '');

  const origin = req.get('origin')?.trim();
  if (origin) return origin.replace(/\/+$/, '');

  const host = req.get('x-forwarded-host') || req.get('host');
  const protocol = req.get('x-forwarded-proto') || req.protocol;
  if (host) return `${protocol}://${host}`;

  return 'https://flashaware.com';
}

function buildInviteEmailHtml(orgName: string, role: string, inviteUrl: string, invitedBy?: string): string {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #111827;">
      <div style="background: #111827; color: #ffffff; padding: 24px; border-radius: 12px 12px 0 0;">
        <h1 style="margin: 0 0 8px; font-size: 24px;">You're invited to join ${orgName}</h1>
        <p style="margin: 0; color: #d1d5db;">Complete your FlashAware signup to access your organisation dashboard.</p>
      </div>
      <div style="padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px; background: #ffffff;">
        <p style="margin: 0 0 16px;">You've been invited${invitedBy ? ` by <strong>${invitedBy}</strong>` : ''} as a <strong>${formatRole(role)}</strong>.</p>
        <p style="margin: 0 0 24px;">This link expires in 7 days.</p>
        <a href="${inviteUrl}" style="display: inline-block; background: #2563eb; color: #ffffff; text-decoration: none; padding: 12px 18px; border-radius: 8px; font-weight: 600;">Create your account</a>
        <p style="margin: 24px 0 8px; color: #6b7280; font-size: 14px;">If the button doesn't work, copy and paste this link into your browser:</p>
        <p style="margin: 0; word-break: break-all; color: #2563eb; font-size: 14px;">${inviteUrl}</p>
      </div>
    </div>
  `;
}

async function sendInviteEmail(email: string, orgName: string, role: string, inviteUrl: string, invitedBy?: string): Promise<void> {
  await getTransporter().sendMail({
    from: process.env.ALERT_FROM || 'lightning-alerts@flashaware.local',
    to: email,
    subject: `FlashAware invite — ${orgName}`,
    html: buildInviteEmailHtml(orgName, role, inviteUrl, invitedBy),
    text: [
      `You've been invited to join ${orgName} on FlashAware as a ${formatRole(role)}${invitedBy ? ` by ${invitedBy}` : ''}.`,
      '',
      'Complete your signup here:',
      inviteUrl,
      '',
      'This link expires in 7 days.',
    ].join('\n'),
  });
}

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

// GET /api/orgs/:id/users — list users for a specific org (super_admin only)
router.get('/:id/users', authenticate, requireRole('super_admin'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const org = await getOne<{ id: string }>('SELECT id FROM organisations WHERE id = $1', [id]);
    if (!org) return res.status(404).json({ error: 'Organisation not found' });
    const users = await getAllUsers(id);
    const sanitized = users.map(({ password_hash, ...u }: any) => u);
    res.json(sanitized);
  } catch (error) {
    logger.error('Failed to list org users', { error: (error as Error).message });
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// DELETE /api/orgs/:id — delete an org and all its data (super_admin only)
router.delete('/:id', authenticate, requireRole('super_admin'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    if (id === '00000000-0000-0000-0000-000000000001') {
      return res.status(403).json({ error: 'The default FlashAware organisation cannot be deleted' });
    }

    const org = await getOne<{ id: string; name: string }>(
      'SELECT id, name FROM organisations WHERE id = $1', [id]
    );
    if (!org) return res.status(404).json({ error: 'Organisation not found' });

    await query('DELETE FROM organisations WHERE id = $1', [id]);

    logger.info('Organisation deleted', { orgId: id, name: org.name, by: req.user?.id });
    res.status(204).send();
  } catch (error) {
    logger.error('Failed to delete org', { error: (error as Error).message });
    res.status(500).json({ error: 'Failed to delete organisation' });
  }
});

// POST /api/orgs — create a new org (super_admin only)
router.post('/', authenticate, requireRole('super_admin'), async (req: AuthRequest, res: Response) => {
  try {
    const { name, slug, invite_email } = createOrgSchema.parse(req.body);
    const onboardingEmail = normalizeEmail(invite_email);

    const existing = await getOne<{ id: string }>('SELECT id FROM organisations WHERE slug = $1', [slug]);
    if (existing) return res.status(409).json({ error: 'An organisation with this slug already exists' });

    if (onboardingEmail) {
      if (!isInviteEmailConfigured()) {
        return res.status(503).json({ error: 'Invite email delivery is not configured on the server' });
      }

      const existingUser = await getOne<{ id: string }>('SELECT id FROM users WHERE email = $1', [onboardingEmail]);
      if (existingUser) return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const orgResult = await client.query<{ id: string; name: string; slug: string; created_at: string }>(
        `INSERT INTO organisations (name, slug) VALUES ($1, $2) RETURNING *`,
        [name, slug]
      );
      const org = orgResult.rows[0];

      if (!org) throw new Error('Failed to create organisation');

      let onboardingInviteUrl: string | null = null;

      if (onboardingEmail) {
        const token = crypto.randomBytes(32).toString('hex');
        onboardingInviteUrl = `${getAppBaseUrl(req)}/register?token=${token}`;

        await client.query(
          `INSERT INTO invite_tokens (token, org_id, role, email) VALUES ($1, $2, $3, $4)`,
          [token, org.id, 'admin', onboardingEmail]
        );

        await sendInviteEmail(onboardingEmail, org.name, 'admin', onboardingInviteUrl, req.user?.name || req.user?.email);
      }

      await client.query('COMMIT');

      logger.info('Organisation created', { orgId: org.id, name, by: req.user?.id, onboardingEmail: onboardingEmail || undefined });
      res.status(201).json({
        ...org,
        onboarding_invite_email: onboardingEmail,
        onboarding_invite_sent: !!onboardingEmail,
        onboarding_invite_url: onboardingInviteUrl,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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
    const normalizedEmail = normalizeEmail(email);

    // Admins can only invite into their own org; super_admin can invite into any org
    const callerOrgId = req.user!.org_id;
    if (req.user!.role !== 'super_admin' && org_id !== callerOrgId) {
      return res.status(403).json({ error: 'You can only create invites for your own organisation' });
    }

    const org = await getOne<{ id: string; name: string }>('SELECT id, name FROM organisations WHERE id = $1', [org_id]);
    if (!org) return res.status(404).json({ error: 'Organisation not found' });

    if (normalizedEmail) {
      if (!isInviteEmailConfigured()) {
        return res.status(503).json({ error: 'Invite email delivery is not configured on the server' });
      }

      const existingUser = await getOne<{ id: string }>('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
      if (existingUser) return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const token = crypto.randomBytes(32).toString('hex');

    const baseUrl = getAppBaseUrl(req);
    const inviteUrl = `${baseUrl}/register?token=${token}`;
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO invite_tokens (token, org_id, role, email) VALUES ($1, $2, $3, $4)`,
        [token, org_id, role, normalizedEmail]
      );

      if (normalizedEmail) {
        await sendInviteEmail(normalizedEmail, org.name, role, inviteUrl, req.user?.name || req.user?.email);
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    logger.info('Invite token created', { orgId: org_id, role, by: req.user?.id, email: normalizedEmail || undefined });

    res.status(201).json({
      token,
      invite_url: inviteUrl,
      org_name: org.name,
      role,
      email: normalizedEmail,
      email_sent: !!normalizedEmail,
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
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedName = name.trim();

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
    if (invite.email && invite.email.toLowerCase() !== normalizedEmail) {
      return res.status(403).json({ error: 'This invite was sent to a different email address' });
    }

    // Check email not already taken
    const existing = await getOne<{ id: string }>('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

    const newUser = await createUser({
      email: normalizedEmail,
      password,
      name: normalizedName,
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

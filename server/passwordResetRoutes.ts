import crypto from 'crypto';
import { z } from 'zod';
import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { pool, query, getOne } from './db';
import { hashPassword, validatePassword, invalidateAuthCache } from './auth';
import { getTransporter } from './alertService';
import { escapeHtml } from './alertTemplates';
import { logger } from './logger';
import { logAudit } from './audit';

const router = Router();

// ============================================================
// Self-service password reset
//
// Design notes:
//   * `/forgot` always returns 200 regardless of whether the email exists.
//     The error surface (rate-limit headers, network timing, etc.) is the
//     only signal an attacker can use to enumerate accounts; we accept
//     that residue and refuse to add a more obvious enumeration vector.
//   * The token in the email is a 32-byte cryptographically random string.
//     The DB stores `sha256(token)` — a snapshot of the table does NOT
//     give an attacker a usable reset URL.
//   * Token lifetime is 30 minutes. Long enough for the email to land and
//     a distracted user to come back to it; short enough that a leaked
//     mailbox archive is mostly stale.
//   * Two rate limits: one per IP (covers credential stuffers spraying
//     many emails from one client) and one per account (covers a single
//     victim being flooded with reset emails). Both bypass the IP limiter
//     so test infrastructure can hammer the endpoint without locking
//     itself out — the per-account limiter still applies.
// ============================================================

const TOKEN_TTL_MS = 30 * 60 * 1000;
// Soft cap on how many reset tokens a single user can spawn in the recent
// window. Past this the endpoint short-circuits with a 200 (no email sent)
// so the victim's inbox isn't weaponised as a flood vector.
const MAX_TOKENS_PER_USER_PER_HOUR = 5;

function isEmailDeliveryConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getAppBaseUrl(req: Request): string {
  // Mirrors server/orgRoutes.ts getAppBaseUrl — kept duplicated rather than
  // re-exported because passwordResetRoutes is a leaf module and we don't
  // want orgRoutes' heavier imports following along.
  const configuredUrl = process.env.APP_URL?.trim();
  if (configuredUrl) return configuredUrl.replace(/\/+$/, '');

  const origin = req.get('origin')?.trim();
  if (origin) return origin.replace(/\/+$/, '');

  const host = req.get('x-forwarded-host') || req.get('host');
  const protocol = req.get('x-forwarded-proto') || req.protocol;
  if (host) return `${protocol}://${host}`;

  return 'https://flashaware.com';
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function buildResetEmailHtml(resetUrl: string, expiresMin: number): string {
  // resetUrl is built from a base URL + cryptographic random token, so it
  // can't contain HTML-active characters. We still encodeURI it for
  // defence-in-depth and to keep odd characters from breaking the anchor.
  const safeUrl = encodeURI(resetUrl).replace(/"/g, '%22');
  const safeMin = String(expiresMin);
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #111827;">
      <div style="background: #0a1929; color: #ffffff; padding: 24px; border-radius: 12px 12px 0 0;">
        <h1 style="margin: 0 0 8px; font-size: 24px;">FlashAware password reset</h1>
        <p style="margin: 0; color: #d1d5db;">We received a request to reset the password on your FlashAware account.</p>
      </div>
      <div style="padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px; background: #ffffff;">
        <p style="margin: 0 0 16px;">Click the button below to choose a new password. This link expires in ${escapeHtml(safeMin)} minutes and can be used once.</p>
        <a href="${safeUrl}" style="display: inline-block; background: #3f51b5; color: #ffffff; text-decoration: none; padding: 12px 18px; border-radius: 8px; font-weight: 600;">Reset your password</a>
        <p style="margin: 24px 0 8px; color: #6b7280; font-size: 14px;">If you didn't request this, you can ignore this email — your password won't change.</p>
        <p style="margin: 12px 0 0; word-break: break-all; color: #3f51b5; font-size: 13px;">${safeUrl}</p>
      </div>
    </div>
  `;
}

async function sendResetEmail(to: string, resetUrl: string): Promise<void> {
  const expiresMin = Math.round(TOKEN_TTL_MS / 60_000);
  await getTransporter().sendMail({
    from: process.env.ALERT_FROM || 'lightning-alerts@flashaware.local',
    to,
    subject: 'FlashAware — reset your password',
    html: buildResetEmailHtml(resetUrl, expiresMin),
    text: [
      'We received a request to reset the password on your FlashAware account.',
      '',
      `Open this link to choose a new password (expires in ${expiresMin} minutes):`,
      resetUrl,
      '',
      "If you didn't request this, ignore this email — your password won't change.",
    ].join('\n'),
  });
}

// Per-IP rate limit. Loose enough that the legitimate "I typed my email
// wrong twice" case isn't punished; tight enough that an enumeration script
// can't fan out forever.
const forgotIpLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: true }, // do not signal "rate limited" — pretend it worked
  handler: (req, res) => {
    logger.warn('Password-reset request IP rate limit hit', {
      ip: req.ip,
      ua: req.get('User-Agent'),
    });
    // Still 200 — we never want this endpoint to surface "we know you're
    // probing". The legitimate user has already had their email queued.
    res.status(200).json({ ok: true });
  },
});

const forgotBodySchema = z.object({
  email: z.string().email().max(254),
});

router.post('/api/auth/forgot', forgotIpLimit, async (req: Request, res: Response) => {
  // Always 200, always uniform body — no timing leaks we can fix at this
  // layer, but we keep the visible API surface flat.
  const respondOk = () => res.json({ ok: true });

  // Synthetic delay to flatten timing between the user-found and
  // user-not-found branches. ~150ms is long enough to dwarf the
  // microseconds-difference of a DB miss vs hit, short enough not to
  // annoy a typical user. Skip in tests so the suite stays snappy.
  const padTiming = async () => {
    if (process.env.NODE_ENV === 'test') return;
    await new Promise((r) => setTimeout(r, 120 + Math.random() * 80));
  };

  const parsed = forgotBodySchema.safeParse(req.body);
  if (!parsed.success) {
    await padTiming();
    return respondOk();
  }

  const email = parsed.data.email.trim().toLowerCase();
  try {
    if (!isEmailDeliveryConfigured()) {
      // Without SMTP we can't deliver the link — but we still don't tell
      // the caller. Log so an operator notices.
      logger.warn('Password-reset requested but SMTP is not configured', { email });
      await padTiming();
      return respondOk();
    }

    const user = await getOne<{ id: string; email: string }>(
      `SELECT u.id, u.email
         FROM users u
         INNER JOIN organisations o ON o.id = u.org_id AND o.deleted_at IS NULL
        WHERE u.email = $1`,
      [email],
    );
    if (!user) {
      await padTiming();
      return respondOk();
    }

    // Per-account throttle: cap how many reset tokens a single account can
    // spawn in the last hour. Stops one user being inbox-bombed with
    // reset emails by an attacker who knows their address.
    const recent = await getOne<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM password_reset_tokens
        WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
      [user.id],
    );
    if (recent && parseInt(recent.c, 10) >= MAX_TOKENS_PER_USER_PER_HOUR) {
      logger.warn('Password-reset per-account throttle hit', {
        userId: user.id,
        recent: recent.c,
      });
      await padTiming();
      return respondOk();
    }

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

    await query(
      `INSERT INTO password_reset_tokens (token_hash, user_id, expires_at, requested_ip)
       VALUES ($1, $2, $3, $4)`,
      [tokenHash, user.id, expiresAt, req.ip || null],
    );

    const resetUrl = `${getAppBaseUrl(req)}/reset/${token}`;
    try {
      await sendResetEmail(user.email, resetUrl);
    } catch (mailErr) {
      // Don't leak SMTP errors to the caller. The token row stays in the DB
      // and the user can request another one if the email never arrives;
      // ops sees the failure in the logs.
      logger.error('Password-reset email delivery failed', {
        userId: user.id,
        error: (mailErr as Error).message,
      });
    }

    await logAudit({
      // Acting as the user themselves; req.user is unauthenticated here, so
      // we override via `actor`. id is the user's own id since the request
      // claims to be on their behalf (verified by the email round-trip).
      req,
      actor: { id: user.id, email: user.email, role: 'self' },
      action: 'user.password_reset_request',
      target_type: 'user',
      target_id: user.id,
      after: { ip: req.ip || null },
    });

    await padTiming();
    return respondOk();
  } catch (err) {
    logger.error('Password-reset request failed', { error: (err as Error).message });
    await padTiming();
    // Still 200 — the error surface is for the operator (logs), not the
    // caller. A 500 would tell an enumerator their input made the server
    // do something unusual.
    return respondOk();
  }
});

const resetBodySchema = z.object({
  token: z.string().min(20).max(256),
  password: z.string().min(1),
});

// Per-IP rate limit on the consume endpoint. Wider window, smaller max —
// a brute-force against the token space is the only thing this could block,
// and it's already infeasible (256 bits of entropy), but cheap protection.
const resetIpLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many reset attempts, please try again later.' },
});

router.post('/api/auth/reset', resetIpLimit, async (req: Request, res: Response) => {
  const parsed = resetBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  const passwordCheck = validatePassword(parsed.data.password);
  if (!passwordCheck.ok) {
    return res.status(400).json({ error: passwordCheck.error });
  }

  const tokenHash = hashToken(parsed.data.token);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Atomic claim: mark the row used in the same statement that selects it,
    // so two parallel POSTs can't both succeed. RETURNING returns the row
    // only when the UPDATE actually flipped used_at — i.e. only the first
    // request through. Subsequent requests see zero rows and 400 out.
    const claim = await client.query<{ user_id: string }>(
      `UPDATE password_reset_tokens
          SET used_at = NOW()
        WHERE token_hash = $1
          AND used_at IS NULL
          AND expires_at > NOW()
        RETURNING user_id`,
      [tokenHash],
    );
    if (claim.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
    }

    const userId = claim.rows[0].user_id;
    const userRow = await client.query<{ id: string; email: string }>(
      `SELECT u.id, u.email
         FROM users u
         INNER JOIN organisations o ON o.id = u.org_id AND o.deleted_at IS NULL
        WHERE u.id = $1`,
      [userId],
    );
    if (userRow.rowCount === 0) {
      // User was deleted (or org was) between request and consume. Don't
      // re-open the token; just fail.
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
    }

    const hashed = await hashPassword(parsed.data.password);
    await client.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hashed, userId]);

    // Invalidate every other live token for this user — if the request was
    // legitimate, the user has just proved control of their inbox; any
    // other outstanding link is either a duplicate of theirs or an
    // attacker's. Either way it should not survive.
    await client.query(
      `UPDATE password_reset_tokens
          SET used_at = NOW()
        WHERE user_id = $1
          AND used_at IS NULL
          AND token_hash <> $2`,
      [userId, tokenHash],
    );

    await client.query('COMMIT');

    // The user_id → auth cache may still hold a "valid principal" entry
    // from a session that was open in another tab. Clear it so any next
    // request with the old session goes through full re-auth (cookies
    // remain technically valid until JWT expiry — for true revocation
    // we'd need server-side session tracking, out of scope here).
    invalidateAuthCache(userId);

    logger.info('Password reset successful', { userId });
    await logAudit({
      req,
      actor: { id: userId, email: userRow.rows[0].email, role: 'self' },
      action: 'user.password_reset_complete',
      target_type: 'user',
      target_id: userId,
    });

    return res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      /* nothing else to do */
    });
    logger.error('Password reset consume failed', { error: (err as Error).message });
    return res.status(500).json({ error: 'Password reset failed' });
  } finally {
    client.release();
  }
});

// Lightweight validity check for the client landing page. Returns
// `{ valid: true }` for a live token, `{ valid: false }` otherwise — no
// account details ever surface, so this is safe to expose unauthenticated.
const verifyParamSchema = z.object({ token: z.string().min(20).max(256) });

router.get('/api/auth/reset/:token/verify', async (req: Request, res: Response) => {
  const parsed = verifyParamSchema.safeParse(req.params);
  if (!parsed.success) return res.json({ valid: false });
  const tokenHash = hashToken(parsed.data.token);
  try {
    const row = await getOne<{ id: string }>(
      `SELECT id FROM password_reset_tokens
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()`,
      [tokenHash],
    );
    return res.json({ valid: !!row });
  } catch (err) {
    logger.error('Password-reset token verify failed', { error: (err as Error).message });
    return res.json({ valid: false });
  }
});

export default router;

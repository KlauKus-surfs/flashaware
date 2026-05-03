import { Router, Response } from 'express';
import { authenticate, requireRole, AuthRequest } from './auth';
import {
  getAppSettings,
  setAppSetting,
  getOrgSettings,
  setOrgSetting,
  clearOrgSettingsCache,
} from './queries';
import { logger } from './logger';
import { logAudit } from './audit';
import { UUID_RE } from './validators';
import { getTransporter, buildEmailHtml } from './alertService';

const router = Router();

// /api/settings:           per-org overrides (caller's own org, or super_admin's scoped org).
//                          GETting also returns the merged effective values.
// /api/platform-settings:  platform-wide defaults — super_admin only.
const SETTINGS_ALLOWED_KEYS = [
  'email_enabled',
  'sms_enabled',
  'whatsapp_enabled',
  'escalation_enabled',
  'escalation_delay_min',
  'alert_from_address',
];

function settingsScopeOrg(req: AuthRequest): string {
  // super_admin can scope writes via the org-picker (?org_id=…). Without it
  // they target their own org (FlashAware default).
  const queryOrg = typeof req.query.org_id === 'string' ? req.query.org_id : undefined;
  if (queryOrg && req.user!.role === 'super_admin' && UUID_RE.test(queryOrg)) return queryOrg;
  return req.user!.org_id;
}

router.get(
  '/api/settings',
  authenticate,
  requireRole('admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const orgId = settingsScopeOrg(req);
      const merged = await getOrgSettings(orgId); // platform defaults + org overrides
      res.json({ ...merged, _scope_org_id: orgId });
    } catch (error) {
      logger.error('Failed to get settings', { error: (error as Error).message });
      res.status(500).json({ error: 'Failed to get settings' });
    }
  },
);

router.post(
  '/api/settings',
  authenticate,
  requireRole('admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const orgId = settingsScopeOrg(req);
      const updates = Object.entries(req.body as Record<string, string>).filter(([k]) =>
        SETTINGS_ALLOWED_KEYS.includes(k),
      );
      const before = await getOrgSettings(orgId);
      await Promise.all(updates.map(([k, v]) => setOrgSetting(orgId, k, String(v))));
      // Drop the cached copy immediately so the next dispatch / escalation
      // sees the fresh value rather than waiting up to ttlMs.
      clearOrgSettingsCache(orgId);
      logger.info('Org settings updated', {
        orgId,
        keys: updates.map(([k]) => k),
        by: req.user?.id,
      });
      await logAudit({
        req,
        action: 'settings.update',
        target_type: 'settings',
        target_id: null,
        target_org_id: orgId,
        before: Object.fromEntries(updates.map(([k]) => [k, before[k]])),
        after: Object.fromEntries(updates),
      });
      res.json({ ok: true });
    } catch (error) {
      logger.error('Failed to save settings', { error: (error as Error).message });
      res.status(500).json({ error: 'Failed to save settings' });
    }
  },
);

router.get(
  '/api/platform-settings',
  authenticate,
  requireRole('super_admin'),
  async (_req: AuthRequest, res: Response) => {
    try {
      const settings = await getAppSettings();
      res.json(settings);
    } catch (error) {
      logger.error('Failed to get platform settings', { error: (error as Error).message });
      res.status(500).json({ error: 'Failed to get platform settings' });
    }
  },
);

router.post(
  '/api/platform-settings',
  authenticate,
  requireRole('super_admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const updates = Object.entries(req.body as Record<string, string>).filter(([k]) =>
        SETTINGS_ALLOWED_KEYS.includes(k),
      );
      const before = await getAppSettings();
      await Promise.all(updates.map(([k, v]) => setAppSetting(k, String(v))));
      // Platform-level changes can flip an org's effective settings (per-org
      // overrides only narrow the platform default). Drop every cached org
      // entry so no follower keeps serving the old value for ttlMs.
      clearOrgSettingsCache();
      logger.info('Platform settings updated', { keys: updates.map(([k]) => k), by: req.user?.id });
      await logAudit({
        req,
        action: 'platform_settings.update',
        target_type: 'platform_settings',
        target_id: null,
        target_org_id: null,
        before: Object.fromEntries(updates.map(([k]) => [k, before[k]])),
        after: Object.fromEntries(updates),
      });
      res.json({ ok: true });
    } catch (error) {
      logger.error('Failed to save platform settings', { error: (error as Error).message });
      res.status(500).json({ error: 'Failed to save platform settings' });
    }
  },
);

// -- Test Email --
router.post(
  '/api/test-email',
  authenticate,
  requireRole('admin'),
  async (req: AuthRequest, res: Response) => {
    const { to } = req.body;
    if (!to || !to.includes('@'))
      return res.status(400).json({ error: 'Valid "to" email is required' });
    try {
      await getTransporter().sendMail({
        from: process.env.ALERT_FROM || 'alerts@flashaware.com',
        to,
        subject: '🟢 FlashAware — Test Alert Email',
        html: buildEmailHtml(
          'Test Location',
          'ALL_CLEAR',
          'This is a test email to confirm your alert notifications are working correctly.',
        ),
      });
      logger.info('Test email sent', { to, by: req.user?.id });
      await logAudit({
        req,
        action: 'alert.test_email',
        target_type: 'alert',
        target_id: null,
        target_org_id: req.user!.org_id,
        after: { to },
      });
      res.json({ ok: true, message: `Test email sent to ${to}` });
    } catch (error) {
      // Admin-only route for testing the admin's own SMTP config — the error
      // detail is intentionally surfaced so they can debug host / auth / port
      // misconfigurations. Bounded length so we don't echo a nodemailer stack
      // trace verbatim.
      const detail = (error as Error).message;
      logger.error('Test email failed', { error: detail, to });
      const truncated = detail.length > 200 ? detail.slice(0, 200) + '…' : detail;
      res.status(500).json({ error: `SMTP error: ${truncated}` });
    }
  },
);

export default router;

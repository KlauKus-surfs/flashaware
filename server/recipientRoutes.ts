import { Router, Response } from 'express';
import { authenticate, requireRole, AuthRequest } from './auth';
import {
  getLocationRecipients,
  addLocationRecipient,
  updateLocationRecipient,
  deleteLocationRecipient,
  getLocationRecipientById,
} from './queries';
import { logger } from './logger';
import { logAudit } from './audit';
import { isValidEmail, isValidE164 } from './validators';
import {
  getLocationForUser,
  sanitizeNotifyStates,
  assertNotifyStatesNotAllOff,
} from './routeHelpers';

const router = Router();

// Mounted at "/" — paths below are absolute. Keeping the full /api/locations
// prefix here means the diff against the previous monolithic index.ts is
// just "move", not "move + rewrite paths", which is much easier to verify.

router.get(
  '/api/locations/:id/recipients',
  authenticate, requireRole('viewer'),
  async (req: AuthRequest, res: Response) => {
    try {
      const loc = await getLocationForUser(req.params.id, req.user!);
      if (!loc) return res.status(404).json({ error: 'Location not found' });
      const recipients = await getLocationRecipients(req.params.id);
      res.json(recipients);
    } catch (error) {
      logger.error('Failed to get recipients', { error: (error as Error).message, locationId: req.params.id });
      res.status(500).json({ error: 'Failed to get recipients' });
    }
  },
);

router.post(
  '/api/locations/:id/recipients',
  authenticate, requireRole('admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const { email, phone } = req.body;
      if (!email || typeof email !== 'string' || !isValidEmail(email)) {
        return res.status(400).json({ error: 'Valid email is required' });
      }
      if (phone !== undefined && phone !== null && phone !== '' && !isValidE164(phone)) {
        return res.status(400).json({ error: 'Phone must be E.164 format (e.g. +27821234567)' });
      }
      const locationId = req.params.id;
      const loc = await getLocationForUser(locationId, req.user!);
      if (!loc) return res.status(404).json({ error: 'Location not found' });

      const { notify_email, notify_sms, notify_whatsapp, notify_states } = req.body;
      const cleanedNotifyStates = sanitizeNotifyStates(notify_states);
      const allOffErr = assertNotifyStatesNotAllOff(cleanedNotifyStates);
      if (allOffErr) return res.status(400).json({ error: allOffErr });
      const id = await addLocationRecipient({
        location_id: locationId,
        email: email.trim().toLowerCase(),
        phone: phone || null,
        active: true,
        notify_email: notify_email !== false,
        notify_sms: !!notify_sms,
        notify_whatsapp: !!notify_whatsapp,
        ...(cleanedNotifyStates ? { notify_states: cleanedNotifyStates } : {}),
      });
      logger.info('Recipient added', { locationId, email, by: req.user?.id });
      await logAudit({
        req,
        action: 'recipient.create',
        target_type: 'recipient',
        target_id: id,
        target_org_id: loc.org_id,
        after: {
          location_id: locationId, email: email.trim().toLowerCase(), phone: phone || null,
          notify_email: notify_email !== false, notify_sms: !!notify_sms, notify_whatsapp: !!notify_whatsapp,
          notify_states: cleanedNotifyStates,
        },
      });
      res.status(201).json({ id });
    } catch (error) {
      logger.error('Failed to add recipient', { error: (error as Error).message, locationId: req.params.id });
      res.status(500).json({ error: 'Failed to add recipient' });
    }
  },
);

router.put(
  '/api/locations/:id/recipients/:recipientId',
  authenticate, requireRole('admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const loc = await getLocationForUser(req.params.id, req.user!);
      if (!loc) return res.status(404).json({ error: 'Location not found' });
      const existing = await getLocationRecipientById(req.params.recipientId);
      if (!existing || existing.location_id !== req.params.id) {
        return res.status(404).json({ error: 'Recipient not found' });
      }
      const { email, phone, active, notify_email, notify_sms, notify_whatsapp, notify_states } = req.body;
      if (email !== undefined && !isValidEmail(email)) {
        return res.status(400).json({ error: 'Valid email is required' });
      }
      if (phone !== undefined && phone !== null && phone !== '' && !isValidE164(phone)) {
        return res.status(400).json({ error: 'Phone must be E.164 format (e.g. +27821234567)' });
      }
      const cleanedNotifyStates = sanitizeNotifyStates(notify_states);
      const allOffErrUpd = assertNotifyStatesNotAllOff(cleanedNotifyStates);
      if (allOffErrUpd) return res.status(400).json({ error: allOffErrUpd });
      // If phone changed, mark phone as unverified again AND force notify_sms /
      // notify_whatsapp to false so they don't silently re-enable the moment the
      // new phone is verified. The user must explicitly opt back in for the new
      // number — same consent surface as a fresh recipient.
      const phoneChanged = phone !== undefined && phone !== existing.phone;
      const updated = await updateLocationRecipient(req.params.recipientId, {
        email, phone, active, notify_email,
        ...(phoneChanged
          ? { phone_verified_at: null, notify_sms: false, notify_whatsapp: false }
          : { notify_sms, notify_whatsapp }),
        ...(cleanedNotifyStates ? { notify_states: cleanedNotifyStates } : {}),
      });
      if (!updated) return res.status(404).json({ error: 'Recipient not found' });
      logger.info('Recipient updated', { recipientId: req.params.recipientId, by: req.user?.id, phoneChanged });
      await logAudit({
        req,
        action: 'recipient.update',
        target_type: 'recipient',
        target_id: req.params.recipientId,
        target_org_id: loc.org_id,
        before: {
          email: existing.email, phone: existing.phone, active: existing.active,
          notify_email: existing.notify_email, notify_sms: existing.notify_sms, notify_whatsapp: existing.notify_whatsapp,
          phone_verified_at: existing.phone_verified_at, notify_states: existing.notify_states,
        },
        after: { email, phone, active, notify_email, notify_sms, notify_whatsapp, phone_changed: phoneChanged, notify_states: cleanedNotifyStates },
      });
      res.json(updated);
    } catch (error) {
      logger.error('Failed to update recipient', { error: (error as Error).message });
      res.status(500).json({ error: 'Failed to update recipient' });
    }
  },
);

router.delete(
  '/api/locations/:id/recipients/:recipientId',
  authenticate, requireRole('admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const loc = await getLocationForUser(req.params.id, req.user!);
      if (!loc) return res.status(404).json({ error: 'Location not found' });
      const existing = await getLocationRecipientById(req.params.recipientId);
      if (!existing || existing.location_id !== req.params.id) {
        return res.status(404).json({ error: 'Recipient not found' });
      }
      const success = await deleteLocationRecipient(req.params.recipientId);
      if (!success) return res.status(404).json({ error: 'Recipient not found' });
      logger.info('Recipient deleted', { recipientId: req.params.recipientId, by: req.user?.id });
      await logAudit({
        req,
        action: 'recipient.delete',
        target_type: 'recipient',
        target_id: req.params.recipientId,
        target_org_id: loc.org_id,
        before: { email: existing.email, phone: existing.phone },
      });
      res.status(204).send();
    } catch (error) {
      logger.error('Failed to delete recipient', { error: (error as Error).message });
      res.status(500).json({ error: 'Failed to delete recipient' });
    }
  },
);

// -- Phone OTP verification for SMS/WhatsApp recipients --
async function loadRecipientForOtp(req: AuthRequest, res: Response) {
  const loc = await getLocationForUser(req.params.id, req.user!);
  if (!loc) { res.status(404).json({ error: 'Location not found' }); return null; }
  const recipient = await getLocationRecipientById(req.params.recipientId);
  if (!recipient || recipient.location_id !== req.params.id) {
    res.status(404).json({ error: 'Recipient not found' }); return null;
  }
  if (!recipient.phone) {
    res.status(400).json({ error: 'Recipient has no phone number' }); return null;
  }
  if (!isValidE164(recipient.phone)) {
    res.status(400).json({ error: 'Recipient phone is not in E.164 format' }); return null;
  }
  return recipient;
}

router.post(
  '/api/locations/:id/recipients/:recipientId/send-otp',
  authenticate, requireRole('admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const recipient = await loadRecipientForOtp(req, res);
      if (!recipient) return;
      const { sendPhoneOtp } = await import('./otpService');
      const result = await sendPhoneOtp(recipient.id, recipient.phone!);
      if (!result.ok) {
        const status = result.reason === 'rate_limited' ? 429
          : result.reason === 'twilio_disabled' ? 503
          : 500;
        return res.status(status).json({
          error: result.error || result.reason || 'Failed to send code',
          reason: result.reason,
          retry_at: result.retry_at,
        });
      }
      const loc = await getLocationForUser(req.params.id, req.user!);
      await logAudit({
        req,
        action: 'recipient.otp_send',
        target_type: 'recipient',
        target_id: recipient.id,
        target_org_id: loc?.org_id ?? null,
        after: { phone: recipient.phone },
      });
      res.json({ ok: true });
    } catch (error) {
      logger.error('Failed to send OTP', { error: (error as Error).message, recipientId: req.params.recipientId });
      res.status(500).json({ error: 'Failed to send verification code' });
    }
  },
);

router.post(
  '/api/locations/:id/recipients/:recipientId/verify-otp',
  authenticate, requireRole('admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const recipient = await loadRecipientForOtp(req, res);
      if (!recipient) return;
      const code = String(req.body?.code || '').trim();
      if (!/^\d{4,8}$/.test(code)) {
        return res.status(400).json({ error: 'Invalid code format' });
      }
      const { verifyPhoneOtp } = await import('./otpService');
      const result = await verifyPhoneOtp(recipient.id, recipient.phone!, code);
      if (!result.ok) {
        const status = result.reason === 'too_many_attempts' ? 429 : 400;
        return res.status(status).json({
          error: result.reason || 'verification_failed',
          reason: result.reason,
          attempts_remaining: result.attempts_remaining,
        });
      }
      const loc = await getLocationForUser(req.params.id, req.user!);
      await logAudit({
        req,
        action: 'recipient.phone_verify',
        target_type: 'recipient',
        target_id: recipient.id,
        target_org_id: loc?.org_id ?? null,
        after: { phone: recipient.phone, verified_at: new Date().toISOString() },
      });
      res.json({ ok: true, verified_at: new Date().toISOString() });
    } catch (error) {
      logger.error('Failed to verify OTP', { error: (error as Error).message, recipientId: req.params.recipientId });
      res.status(500).json({ error: 'Failed to verify code' });
    }
  },
);

// -- Send Test Alert to a single recipient (admin only) --
// Fires a benign "this is a test" message via every channel the recipient has
// enabled (email + SMS + WhatsApp gated on phone verification). Used by the
// LocationEditor "Send Test" button. Does NOT write to the alerts table —
// it isn't a real alert — but DOES log to the audit trail.
router.post(
  '/api/locations/:id/recipients/:recipientId/test',
  authenticate, requireRole('admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const loc = await getLocationForUser(req.params.id, req.user!);
      if (!loc) return res.status(404).json({ error: 'Location not found' });
      const existing = await getLocationRecipientById(req.params.recipientId);
      if (!existing || existing.location_id !== req.params.id) {
        return res.status(404).json({ error: 'Recipient not found' });
      }
      const { sendTestAlertToRecipient } = await import('./alertService');
      const result = await sendTestAlertToRecipient(existing.id);
      await logAudit({
        req,
        action: 'alert.test_send',
        target_type: 'recipient',
        target_id: existing.id,
        target_org_id: loc.org_id,
        after: { channels: result.attempted, any_sent: result.any_sent },
      });
      res.json(result);
    } catch (error) {
      logger.error('Failed to send test alert', { error: (error as Error).message, recipientId: req.params.recipientId });
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

export default router;

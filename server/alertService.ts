import { createTransport } from 'nodemailer';
import twilio from 'twilio';
import {
  getLocationRecipients,
  getAlerts,
  escalateAlert,
  addAlert,
  getAllRiskStates,
  getLocationById,
  getAppSettings,
  getOrgSettings,
  getOrgAdminEmails,
  getOrgIdForLocation,
  shouldNotifyForState,
} from './queries';
import { DateTime } from 'luxon';
import { alertLogger } from './logger';
import { wsManager } from './websocket';
import {
  STATE_LABELS,
  getStateInfo,
  buildSmsBody,
  buildWhatsAppBody,
  buildEmailHtml as buildEmailHtmlTpl,
  buildEscalationHtml,
} from './alertTemplates';
import { generateAckToken, ackTokenExpiry, hashAckToken } from './ackToken';
import type { Logger } from 'pino';

// Used to build the ack URL embedded in delivered messages. SERVER_URL
// is set via fly.toml in prod; locally it falls back to the API origin.
const ACK_BASE_URL = process.env.SERVER_URL || 'https://lightning-risk-api.fly.dev';

// Re-export for backwards compatibility — index.ts and tests import buildEmailHtml from './alertService'.
export const buildEmailHtml = buildEmailHtmlTpl;

interface Recipient {
  email: string;
  phone: string | null;
}

// Twilio SMS/WhatsApp client (lazy-init so missing creds don't crash startup)
function getTwilioClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  return twilio(sid, token);
}

/**
 * Capability flags for the notifier subsystem. The dashboard reads these
 * from /api/health so operators can see at a glance whether email/SMS/WhatsApp
 * dispatch is even possible — much cheaper than discovering it at the first
 * STOP alert.
 */
export interface NotifierCapabilities {
  email_enabled: boolean;
  sms_enabled: boolean;
  whatsapp_enabled: boolean;
}

export function getNotifierCapabilities(): NotifierCapabilities {
  return {
    email_enabled: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
    sms_enabled: Boolean(
      process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM,
    ),
    whatsapp_enabled: Boolean(
      process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_WHATSAPP_FROM,
    ),
  };
}

/**
 * Called once at boot to surface missing notifier config in the logs. In
 * production a missing host is treated as an error so it shows up on standard
 * error-monitoring dashboards rather than disappearing into INFO noise.
 */
export function validateNotifierConfig(logger: Pick<Logger, 'warn' | 'error'>): void {
  const caps = getNotifierCapabilities();
  const isProd = process.env.NODE_ENV === 'production';
  const log = isProd ? logger.error : logger.warn;
  if (!caps.email_enabled) {
    log.call(
      logger,
      'SMTP not fully configured — email alerts will fail. Required: SMTP_HOST, SMTP_USER, SMTP_PASS',
    );
  }
  if (!caps.sms_enabled) {
    log.call(
      logger,
      'Twilio SMS not configured — SMS alerts will fail. Required: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM',
    );
  }
  if (!caps.whatsapp_enabled) {
    log.call(
      logger,
      'Twilio WhatsApp not configured — WhatsApp alerts will fail. Required: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM',
    );
  }
}

// Email transport — lazy singleton so dotenv has been loaded before createTransport runs
let _transporter: ReturnType<typeof createTransport> | null = null;

export function getTransporter(): ReturnType<typeof createTransport> {
  if (!_transporter) {
    const port = parseInt(process.env.SMTP_PORT || '587');
    _transporter = createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return _transporter;
}

export async function dispatchAlerts(
  locationId: string,
  stateId: bigint,
  state: string,
  reason: string,
): Promise<void> {
  const info = getStateInfo(state);
  const now = DateTime.utc().toISO()!;

  try {
    // Resolve human-readable location name
    const location = await getLocationById(locationId);
    const locationName = location?.name || locationId;

    // Always log a system alert record regardless of email recipients
    const systemAlertId = await addAlert({
      location_id: locationId,
      state_id: Number(stateId),
      alert_type: 'system',
      recipient: 'system',
      sent_at: now,
      delivered_at: now,
      acknowledged_at: null,
      acknowledged_by: null,
      escalated: false,
      error: null,
      twilio_sid: null,
      ack_token: null,
      ack_token_expires_at: null,
    });

    alertLogger.info('Alert logged', { alertId: systemAlertId, locationId, locationName, state });

    // Broadcast via WebSocket
    wsManager.broadcastAlertTriggered({
      locationId,
      locationName,
      alertType: 'system',
      state,
      reason,
      timestamp: now,
      org_id: location?.org_id || '',
    });

    // Get location recipients for email
    const recipients = await getLocationRecipients(locationId);

    if (recipients.length === 0) {
      alertLogger.warn('No email recipients configured for location', { locationId, locationName });
      return;
    }

    const twilioClient = getTwilioClient();
    const twilioSmsFrom = process.env.TWILIO_FROM;
    const twilioWhatsAppFrom = process.env.TWILIO_WHATSAPP_FROM
      ? `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`
      : twilioSmsFrom
        ? `whatsapp:${twilioSmsFrom}`
        : null;

    // Check channel-enabled settings — per-org override falls back to platform default.
    // sms_enabled / whatsapp_enabled default to false (opt-in per tenant); email
    // defaults to true (the historic behaviour) and must be explicitly disabled.
    const settings = location?.org_id
      ? await getOrgSettings(location.org_id)
      : await getAppSettings();
    const emailEnabled = settings['email_enabled'] !== 'false';
    const smsEnabled = settings['sms_enabled'] === 'true';
    const whatsappEnabled = settings['whatsapp_enabled'] === 'true';

    // Send email + SMS + WhatsApp to each recipient
    for (const recipient of recipients) {
      // Per-state opt-in: skip this recipient entirely if they've opted out of
      // this risk state. Fail-safe: missing keys default to subscribed.
      if (!shouldNotifyForState(recipient.notify_states, state)) {
        alertLogger.info('Recipient skipped (state not in notify_states)', {
          locationId,
          recipient: recipient.email,
          state,
        });
        continue;
      }

      // --- Email (opt-in per recipient, also gated by per-org setting) ---
      const recipientWantsEmail = recipient.notify_email !== false; // default true
      if (emailEnabled && recipientWantsEmail) {
        const emailToken = generateAckToken();
        const emailAckUrl = `${ACK_BASE_URL}/a/${emailToken}`;
        const emailExpiresAt = ackTokenExpiry().toISOString();
        try {
          const emailHtml = buildEmailHtml(locationName, state, reason, emailAckUrl);
          const fromAddress =
            settings['alert_from_address'] ||
            process.env.ALERT_FROM ||
            'lightning-alerts@flashaware.local';
          await getTransporter().sendMail({
            from: fromAddress,
            to: recipient.email,
            subject: `${info.emoji} ${info.subject} - ${locationName}`,
            html: emailHtml,
          });
          const alertId = await addAlert({
            location_id: locationId,
            state_id: Number(stateId),
            alert_type: 'email',
            recipient: recipient.email,
            sent_at: now,
            delivered_at: now,
            acknowledged_at: null,
            acknowledged_by: null,
            escalated: false,
            error: null,
            twilio_sid: null,
            // Plaintext goes out in the email link; only the SHA-256 hash is
            // persisted here. publicAckRoutes hashes the path param and
            // looks up by the hash. See ackToken.ts.
            ack_token: hashAckToken(emailToken),
            ack_token_expires_at: emailExpiresAt,
          });
          alertLogger.info('Email alert dispatched', {
            alertId,
            locationId,
            state,
            recipient: recipient.email,
          });
        } catch (emailError) {
          await addAlert({
            location_id: locationId,
            state_id: Number(stateId),
            alert_type: 'email',
            recipient: recipient.email,
            sent_at: now,
            delivered_at: null,
            acknowledged_at: null,
            acknowledged_by: null,
            escalated: false,
            error: (emailError as Error).message,
            twilio_sid: null,
            // Send failed — the recipient never received the URL, so persist
            // null rather than the pre-generated token. (Token entropy is
            // wasted but never escapes anywhere live.)
            ack_token: null,
            ack_token_expires_at: null,
          });
          alertLogger.error('Failed to send alert email', {
            locationId,
            state,
            recipient: recipient.email,
            error: (emailError as Error).message,
          });
        }
      } else if (!recipientWantsEmail) {
        alertLogger.info('Email skipped (recipient opted out)', {
          locationId,
          recipient: recipient.email,
        });
      } else {
        alertLogger.info('Email skipped (globally disabled)', {
          locationId,
          recipient: recipient.email,
        });
      }

      // --- SMS (opt-in per recipient + phone must be OTP-verified + org-level SMS enabled) ---
      if (recipient.phone && recipient.notify_sms && !smsEnabled) {
        alertLogger.info('SMS skipped (disabled at org/platform level)', {
          locationId,
          recipient: recipient.phone,
        });
      } else if (recipient.phone && recipient.notify_sms && !recipient.phone_verified_at) {
        alertLogger.info('SMS skipped (phone not yet verified)', {
          locationId,
          recipient: recipient.phone,
        });
      } else if (
        recipient.phone &&
        recipient.notify_sms &&
        recipient.phone_verified_at &&
        twilioClient &&
        twilioSmsFrom
      ) {
        const smsToken = generateAckToken();
        const smsAckUrl = `${ACK_BASE_URL}/a/${smsToken}`;
        const smsExpiresAt = ackTokenExpiry().toISOString();
        try {
          const smsBody = buildSmsBody(locationName, state, reason, smsAckUrl);
          await twilioClient.messages.create({
            body: smsBody,
            from: twilioSmsFrom,
            to: recipient.phone,
          });
          const smsAlertId = await addAlert({
            location_id: locationId,
            state_id: Number(stateId),
            alert_type: 'sms',
            recipient: recipient.phone,
            sent_at: now,
            delivered_at: now,
            acknowledged_at: null,
            acknowledged_by: null,
            escalated: false,
            error: null,
            twilio_sid: null,
            ack_token: hashAckToken(smsToken),
            ack_token_expires_at: smsExpiresAt,
          });
          alertLogger.info('SMS alert dispatched', {
            smsAlertId,
            locationId,
            state,
            recipient: recipient.phone,
          });
        } catch (smsError) {
          await addAlert({
            location_id: locationId,
            state_id: Number(stateId),
            alert_type: 'sms',
            recipient: recipient.phone,
            sent_at: now,
            delivered_at: null,
            acknowledged_at: null,
            acknowledged_by: null,
            escalated: false,
            error: (smsError as Error).message,
            twilio_sid: null,
            // Send failed — the recipient never received the URL, so persist
            // null rather than the pre-generated token. (Token entropy is
            // wasted but never escapes anywhere live.)
            ack_token: null,
            ack_token_expires_at: null,
          });
          alertLogger.error('Failed to send SMS alert', {
            locationId,
            state,
            recipient: recipient.phone,
            error: (smsError as Error).message,
          });
        }
      }

      // --- WhatsApp (opt-in per recipient + phone must be OTP-verified + org-level WhatsApp enabled) ---
      if (recipient.phone && recipient.notify_whatsapp && !whatsappEnabled) {
        alertLogger.info('WhatsApp skipped (disabled at org/platform level)', {
          locationId,
          recipient: recipient.phone,
        });
      } else if (recipient.phone && recipient.notify_whatsapp && !recipient.phone_verified_at) {
        alertLogger.info('WhatsApp skipped (phone not yet verified)', {
          locationId,
          recipient: recipient.phone,
        });
      } else if (
        recipient.phone &&
        recipient.notify_whatsapp &&
        recipient.phone_verified_at &&
        twilioClient &&
        twilioWhatsAppFrom
      ) {
        const waTo = `whatsapp:${recipient.phone}`;
        // Use approved per-state template when available, else fall back to generic approved template
        const WA_TEMPLATE_SIDS: Record<string, string | undefined> = {
          STOP: process.env.TWILIO_WA_TEMPLATE_STOP,
          PREPARE: process.env.TWILIO_WA_TEMPLATE_PREPARE,
          HOLD: process.env.TWILIO_WA_TEMPLATE_HOLD,
          ALL_CLEAR: process.env.TWILIO_WA_TEMPLATE_ALL_CLEAR,
          DEGRADED: process.env.TWILIO_WA_TEMPLATE_DEGRADED,
        };
        const stateTemplateSid = WA_TEMPLATE_SIDS[state];
        const templateSid = stateTemplateSid || process.env.TWILIO_WHATSAPP_TEMPLATE_SID;
        const useTemplate = !!templateSid;
        const waToken = useTemplate ? null : generateAckToken();
        const waAckUrl = waToken ? `${ACK_BASE_URL}/a/${waToken}` : undefined;
        const waExpiresAt = waToken ? ackTokenExpiry().toISOString() : null;
        const actionMsg = reason.length > 200 ? reason.substring(0, 197) + '...' : reason;
        // Per-state templates use 2 vars (location + detail);
        // generic fallback template uses 3 vars (location + status label + detail).
        const contentVariables = stateTemplateSid
          ? JSON.stringify({ '1': locationName, '2': actionMsg })
          : JSON.stringify({ '1': locationName, '2': `${info.emoji} ${state}`, '3': actionMsg });
        const statusCallback = process.env.SERVER_URL
          ? `${process.env.SERVER_URL}/api/webhooks/twilio-status`
          : 'https://lightning-risk-api.fly.dev/api/webhooks/twilio-status';
        const messageParams = templateSid
          ? {
              from: twilioWhatsAppFrom,
              to: waTo,
              contentSid: templateSid,
              contentVariables,
              statusCallback,
            }
          : {
              body: buildWhatsAppBody(locationName, state, reason, waAckUrl),
              from: twilioWhatsAppFrom,
              to: waTo,
              statusCallback,
            };
        let waMsg: { sid: string } | null = null;
        let waErrMsg: string | null = null;
        try {
          waMsg = await twilioClient.messages.create(messageParams as any);
        } catch (templateErr: any) {
          // Template not yet approved (63016) or outside session (63112) — fall back to freeform
          const code = templateErr?.code ?? templateErr?.status;
          const isTemplateFail =
            code === 63016 ||
            code === 63032 ||
            String(templateErr?.message).includes('63016') ||
            String(templateErr?.message).includes('63032');
          if (isTemplateFail && templateSid) {
            alertLogger.warn('WhatsApp template rejected, retrying as freeform', {
              code,
              recipient: recipient.phone,
            });
            try {
              waMsg = await twilioClient.messages.create({
                body: buildWhatsAppBody(locationName, state, reason, waAckUrl),
                from: twilioWhatsAppFrom,
                to: waTo,
                statusCallback,
              } as any);
            } catch (freeformErr: any) {
              waErrMsg = `template:${templateErr.message} | freeform:${freeformErr.message}`;
            }
          } else {
            waErrMsg = templateErr.message;
          }
        }
        if (waMsg) {
          const waAlertId = await addAlert({
            location_id: locationId,
            state_id: Number(stateId),
            alert_type: 'whatsapp',
            recipient: recipient.phone,
            sent_at: now,
            delivered_at: null,
            acknowledged_at: null,
            acknowledged_by: null,
            escalated: false,
            error: null,
            twilio_sid: waMsg.sid,
            // Template path produces no token (templates can't carry a per-
            // alert URL through the WhatsApp template content). Only hash
            // when we actually generated one.
            ack_token: waToken ? hashAckToken(waToken) : null,
            ack_token_expires_at: waExpiresAt,
          });
          alertLogger.info('WhatsApp alert dispatched', {
            waAlertId,
            locationId,
            state,
            recipient: recipient.phone,
            twilioSid: waMsg.sid,
          });
        } else {
          await addAlert({
            location_id: locationId,
            state_id: Number(stateId),
            alert_type: 'whatsapp',
            recipient: recipient.phone,
            sent_at: now,
            delivered_at: null,
            acknowledged_at: null,
            acknowledged_by: null,
            escalated: false,
            error: waErrMsg,
            twilio_sid: null,
            // Send failed — the recipient never received the URL, so persist
            // null rather than the pre-generated token. (Token entropy is
            // wasted but never escapes anywhere live.)
            ack_token: null,
            ack_token_expires_at: null,
          });
          alertLogger.error('Failed to send WhatsApp alert', {
            locationId,
            state,
            recipient: recipient.phone,
            error: waErrMsg,
          });
        }
      }
    }
  } catch (error) {
    alertLogger.error('Failed to dispatch alerts', {
      locationId,
      state,
      error: (error as Error).message,
    });
  }
}

let escalationCheckRunning = false;

export async function checkEscalations(): Promise<void> {
  if (escalationCheckRunning) {
    alertLogger.warn('Skipping escalation check — previous run still in progress');
    return;
  }
  escalationCheckRunning = true;
  try {
    // We pull all alerts older than 1 minute then filter per-alert against the
    // owning org's escalation_delay_min. This way each org can configure its
    // own escalation timing without us querying once per org.
    const { getUnacknowledgedAlerts: getUnack } = await import('./queries');
    const unacknowledgedAlerts = await getUnack(1);

    for (const alert of unacknowledgedAlerts) {
      if (alert.alert_type !== 'email' || alert.escalated) continue;

      // Resolve the alert's org and read its escalation config.
      const orgId = await getOrgIdForLocation(alert.location_id);
      if (!orgId) continue;
      const orgSettings = await getOrgSettings(orgId);
      if (orgSettings['escalation_enabled'] === 'false') continue;
      const delayMin = parseInt(orgSettings['escalation_delay_min'] || '10', 10);

      // Has enough time elapsed under this org's policy?
      const sentAt = alert.sent_at ? new Date(alert.sent_at).getTime() : null;
      if (!sentAt || Date.now() - sentAt < delayMin * 60_000) continue;

      // If the org has email globally disabled we have no transport for the
      // escalation. We still mark the alert escalated so we don't keep retrying
      // on every cycle once the timer has elapsed.
      if (orgSettings['email_enabled'] === 'false') {
        await escalateAlert(alert.id);
        alertLogger.info('Escalation suppressed — email disabled for org', {
          alertId: alert.id,
          orgId,
        });
        continue;
      }

      alertLogger.warn('Escalating unacknowledged alert', {
        alertId: alert.id,
        recipient: alert.recipient,
        sentAt: alert.sent_at,
        orgId,
        delayMin,
      });

      // Mark escalated first so we don't re-send on the next cycle
      await escalateAlert(alert.id);

      try {
        const adminEmails = await getOrgAdminEmails(orgId);
        if (adminEmails.length > 0) {
          const location = await getLocationById(alert.location_id);
          const locationName = location?.name || alert.location_id;
          const escalationHtml = buildEscalationHtml({
            locationName,
            recipientEmail: alert.recipient,
            alertId: alert.id,
            sentAt: alert.sent_at,
            delayMin,
          });
          await getTransporter().sendMail({
            from:
              orgSettings['alert_from_address'] || process.env.ALERT_FROM || 'alerts@flashaware.io',
            to: adminEmails.join(','),
            subject: `⚠️ ESCALATION — Unacknowledged alert for ${locationName} (ID #${alert.id})`,
            html: escalationHtml,
          });
          alertLogger.info('Escalation email sent', {
            alertId: alert.id,
            locationName,
            adminEmails,
          });
        }
      } catch (escalationSendError) {
        alertLogger.error('Failed to send escalation email', {
          alertId: alert.id,
          error: (escalationSendError as Error).message,
        });
      }
    }
  } catch (error) {
    alertLogger.error('Error checking escalations', { error: (error as Error).message });
  } finally {
    escalationCheckRunning = false;
  }
}

export interface TestSendChannelResult {
  channel: 'email' | 'sms' | 'whatsapp';
  ok: boolean;
  skipped?:
    | 'disabled'
    | 'no_phone'
    | 'phone_unverified'
    | 'transport_unconfigured'
    | 'recipient_inactive';
  error?: string;
}

export interface TestSendResult {
  attempted: TestSendChannelResult[];
  any_sent: boolean;
}

/**
 * Send a benign "this is a test" message to one recipient via every channel
 * they have enabled. Used by the LocationEditor "Send Test" button so admins
 * can validate notification setup without waiting for a real storm.
 *
 * The message uses ALL_CLEAR styling intentionally — green, non-alarming —
 * so a recipient who reads it carefully knows it isn't a real alert. We do
 * NOT write to the alerts table (it's not a real alert) but we DO log to the
 * audit trail so there's a record of who pinged whom.
 *
 * `expectedOrgId` is a defence-in-depth check: the route handler already
 * verifies recipient → location → org_id matches the caller's scope, but
 * passing the verified org_id here lets this function fail loudly if it ever
 * gets called from a new code path (cron, webhook, internal trigger) that
 * skips the route-level check. Throwing on mismatch is a strictly larger
 * blast radius than silently sending — that's the right tradeoff for a
 * cross-tenant signal.
 */
export async function sendTestAlertToRecipient(
  recipientId: string | number,
  expectedOrgId?: string,
): Promise<TestSendResult> {
  const recipient = await (await import('./queries')).getLocationRecipientById(String(recipientId));
  if (!recipient) throw new Error('Recipient not found');
  const location = await getLocationById(recipient.location_id);
  if (expectedOrgId !== undefined && location?.org_id !== expectedOrgId) {
    // Loud failure — and a generic error message, not an oracle telling the
    // attacker which org they hit.
    alertLogger.error('Test alert blocked: recipient org_id does not match caller scope', {
      recipientId,
      recipientLocationOrgId: location?.org_id,
      expectedOrgId,
    });
    throw new Error('Recipient is not in the expected organisation');
  }
  const locationName = location?.name || recipient.location_id;

  const reason =
    'This is a test message — no actual lightning detected. Your alert configuration is working.';
  const results: TestSendChannelResult[] = [];

  // Inactive recipients are paused — real alerts skip them at getLocationRecipients
  // (which filters active=true), so the test path must mirror that. Otherwise an
  // admin sees a "test sent" toast for a recipient who would never get the real
  // thing, which is actively misleading.
  if (recipient.active === false) {
    return {
      attempted: [
        { channel: 'email', ok: false, skipped: 'recipient_inactive' },
        { channel: 'sms', ok: false, skipped: 'recipient_inactive' },
        { channel: 'whatsapp', ok: false, skipped: 'recipient_inactive' },
      ],
      any_sent: false,
    };
  }

  // Email
  const wantEmail = recipient.notify_email !== false;
  if (!wantEmail) {
    results.push({ channel: 'email', ok: false, skipped: 'disabled' });
  } else if (!process.env.SMTP_HOST) {
    results.push({ channel: 'email', ok: false, skipped: 'transport_unconfigured' });
  } else {
    try {
      await getTransporter().sendMail({
        from: process.env.ALERT_FROM || 'alerts@flashaware.com',
        to: recipient.email,
        subject: `🟢 FlashAware — Test Alert (${locationName})`,
        html: buildEmailHtml(locationName, 'ALL_CLEAR', reason),
      });
      results.push({ channel: 'email', ok: true });
    } catch (err) {
      results.push({ channel: 'email', ok: false, error: (err as Error).message });
    }
  }

  // SMS / WhatsApp share the phone-verified gate
  const twilioClient = getTwilioClient();
  const twilioSmsFrom = process.env.TWILIO_FROM;
  const twilioWaFrom = process.env.TWILIO_WHATSAPP_FROM
    ? `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`
    : null;

  // SMS
  if (!recipient.notify_sms) {
    results.push({ channel: 'sms', ok: false, skipped: 'disabled' });
  } else if (!recipient.phone) {
    results.push({ channel: 'sms', ok: false, skipped: 'no_phone' });
  } else if (!recipient.phone_verified_at) {
    results.push({ channel: 'sms', ok: false, skipped: 'phone_unverified' });
  } else if (!twilioClient || !twilioSmsFrom) {
    results.push({ channel: 'sms', ok: false, skipped: 'transport_unconfigured' });
  } else {
    try {
      await twilioClient.messages.create({
        body: `🟢 FlashAware TEST — ${locationName}\n${reason}\nflashaware.com`,
        from: twilioSmsFrom,
        to: recipient.phone,
      });
      results.push({ channel: 'sms', ok: true });
    } catch (err) {
      results.push({ channel: 'sms', ok: false, error: (err as Error).message });
    }
  }

  // WhatsApp
  if (!recipient.notify_whatsapp) {
    results.push({ channel: 'whatsapp', ok: false, skipped: 'disabled' });
  } else if (!recipient.phone) {
    results.push({ channel: 'whatsapp', ok: false, skipped: 'no_phone' });
  } else if (!recipient.phone_verified_at) {
    results.push({ channel: 'whatsapp', ok: false, skipped: 'phone_unverified' });
  } else if (!twilioClient || !twilioWaFrom) {
    results.push({ channel: 'whatsapp', ok: false, skipped: 'transport_unconfigured' });
  } else {
    try {
      await twilioClient.messages.create({
        body: `*🟢 FlashAware TEST*\n*${locationName}*\n\n${reason}\n\nflashaware.com`,
        from: twilioWaFrom,
        to: `whatsapp:${recipient.phone}`,
      });
      results.push({ channel: 'whatsapp', ok: true });
    } catch (err) {
      results.push({ channel: 'whatsapp', ok: false, error: (err as Error).message });
    }
  }

  return { attempted: results, any_sent: results.some((r) => r.ok) };
}

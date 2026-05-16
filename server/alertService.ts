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
  getOrgSettingsCached,
  getOrgAdminEmails,
  getOrgIdForLocation,
  hasRecentOrgFeedNotice,
  shouldNotifyForState,
} from './queries';
import { DateTime } from 'luxon';
import { alertLogger, maskPhone } from './logger';
import { wsManager } from './websocket';
import {
  STATE_LABELS,
  getStateInfo,
  buildSmsBody,
  buildWhatsAppBody,
  buildEmailHtml as buildEmailHtmlTpl,
  buildEscalationHtml,
  ReasonObject,
} from './alertTemplates';
import { generateAckToken, ackTokenExpiry, hashAckToken } from './ackToken';
import { mapWithConcurrency } from './concurrency';
import type { Logger } from 'pino';
import type { AlertRecord } from './queries/alerts';

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
  reason: string | ReasonObject,
  stop_radius_km?: number,
  prepare_radius_km?: number,
  stop_window_min?: number,
  prepare_window_min?: number,
): Promise<void> {
  const info = getStateInfo(state);
  const now = DateTime.utc().toISO()!;

  try {
    // Resolve human-readable location name
    const location = await getLocationById(locationId);
    const locationName = location?.name || locationId;

    // Extract string reason for logging and websocket
    const reasonStr = typeof reason === 'string' ? reason : reason.reason;

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
      reason: reasonStr,
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
      ? await getOrgSettingsCached(location.org_id)
      : await getAppSettings();
    const emailEnabled = settings['email_enabled'] !== 'false';
    const smsEnabled = settings['sms_enabled'] === 'true';
    const whatsappEnabled = settings['whatsapp_enabled'] === 'true';

    // Per-recipient dispatch is parallelised with a small concurrency cap so
    // a 50-recipient STOP doesn't take a full minute of wall clock to reach
    // the last operator. Previously: serial across recipients × channels →
    // wall time grew linearly with recipients × channels. Now: at most
    // DISPATCH_CONCURRENCY recipients in flight at once, and within each
    // recipient the three channels run in parallel via Promise.all.
    //
    // Each channel function below writes its own row (success or failure)
    // and owns its own try/catch, so a Twilio failure on one channel can't
    // fail-fast the whole batch and an SMTP timeout for one recipient
    // doesn't delay another recipient's SMS.
    //
    // The cap protects against SMTP connection storms (no pooling
    // configured on the transport) and Twilio's per-account QPS limits.
    // Tuned via env so ops can throttle on a noisy night without a deploy.
    const dispatchConcurrency = parseInt(process.env.DISPATCH_CONCURRENCY || '8', 10);

    type RecipientRow = (typeof recipients)[number];

    async function dispatchEmail(recipient: RecipientRow): Promise<void> {
      const recipientWantsEmail = recipient.notify_email !== false; // default true
      if (!emailEnabled) {
        alertLogger.info('Email skipped (globally disabled)', {
          locationId,
          recipient: recipient.email,
        });
        return;
      }
      if (!recipientWantsEmail) {
        alertLogger.info('Email skipped (recipient opted out)', {
          locationId,
          recipient: recipient.email,
        });
        return;
      }
      const emailToken = generateAckToken();
      const emailAckUrl = `${ACK_BASE_URL}/a/${emailToken}`;
      const emailExpiresAt = ackTokenExpiry().toISOString();
      try {
        const emailHtml = buildEmailHtml(
          locationName,
          state,
          reason,
          emailAckUrl,
          stop_radius_km,
          prepare_radius_km,
          stop_window_min,
          prepare_window_min,
        );
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
    }

    async function dispatchSms(recipient: RecipientRow): Promise<void> {
      if (!recipient.phone || !recipient.notify_sms) return;
      if (!smsEnabled) {
        alertLogger.info('SMS skipped (disabled at org/platform level)', {
          locationId,
          recipient: maskPhone(recipient.phone),
        });
        return;
      }
      if (!recipient.phone_verified_at) {
        alertLogger.info('SMS skipped (phone not yet verified)', {
          locationId,
          recipient: maskPhone(recipient.phone),
        });
        return;
      }
      if (!twilioClient || !twilioSmsFrom) return;
      {
        const smsToken = generateAckToken();
        const smsAckUrl = `${ACK_BASE_URL}/a/${smsToken}`;
        const smsExpiresAt = ackTokenExpiry().toISOString();
        try {
          const smsBody = buildSmsBody(
            locationName,
            state,
            reason,
            smsAckUrl,
            stop_radius_km,
            prepare_radius_km,
            stop_window_min,
            prepare_window_min,
          );
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
            recipient: maskPhone(recipient.phone),
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
            recipient: maskPhone(recipient.phone),
            error: (smsError as Error).message,
          });
        }
      }
    }

    async function dispatchWhatsApp(recipient: RecipientRow): Promise<void> {
      if (!recipient.phone || !recipient.notify_whatsapp) return;
      if (!whatsappEnabled) {
        alertLogger.info('WhatsApp skipped (disabled at org/platform level)', {
          locationId,
          recipient: maskPhone(recipient.phone),
        });
        return;
      }
      if (!recipient.phone_verified_at) {
        alertLogger.info('WhatsApp skipped (phone not yet verified)', {
          locationId,
          recipient: maskPhone(recipient.phone),
        });
        return;
      }
      if (!twilioClient || !twilioWhatsAppFrom) return;
      {
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
        const actionMsg =
          reasonStr.length > 200 ? reasonStr.substring(0, 197) + '...' : reasonStr;
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
              body: buildWhatsAppBody(
                locationName,
                state,
                reason,
                waAckUrl,
                stop_radius_km,
                prepare_radius_km,
                stop_window_min,
                prepare_window_min,
              ),
              from: twilioWhatsAppFrom,
              to: waTo,
              statusCallback,
            };
        let waMsg: { sid: string } | null = null;
        let waErrMsg: string | null = null;
        try {
          waMsg = await twilioClient.messages.create(messageParams as any);
        } catch (templateErr: any) {
          // Twilio WhatsApp error taxonomy we care about:
          //   63016 — template not yet approved
          //   63032 — template content rejected at send time
          //     → freeform fallback works IF inside a 24h session window.
          //   63112 — outside 24h conversation window
          //     → freeform also requires an open session, so fallback would
          //       fail too. Skip the retry, save ~3s of latency, log as-is.
          const code = templateErr?.code ?? templateErr?.status;
          const msg = String(templateErr?.message ?? '');
          const isApprovalIssue =
            code === 63016 || code === 63032 || msg.includes('63016') || msg.includes('63032');
          const isSessionWindow = code === 63112 || msg.includes('63112');
          if (isApprovalIssue && !isSessionWindow && templateSid) {
            alertLogger.warn('WhatsApp template rejected, retrying as freeform', {
              code,
              recipient: maskPhone(recipient.phone),
            });
            try {
              waMsg = await twilioClient.messages.create({
                body: buildWhatsAppBody(
                locationName,
                state,
                reason,
                waAckUrl,
                stop_radius_km,
                prepare_radius_km,
                stop_window_min,
                prepare_window_min,
              ),
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
            recipient: maskPhone(recipient.phone),
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
            recipient: maskPhone(recipient.phone),
            error: waErrMsg,
          });
        }
      }
    }

    await mapWithConcurrency(recipients, dispatchConcurrency, async (recipient) => {
      // Per-state opt-in: skip this recipient entirely if they've opted out
      // of this risk state. Fail-safe: missing keys default to subscribed.
      if (!shouldNotifyForState(recipient.notify_states, state)) {
        alertLogger.info('Recipient skipped (state not in notify_states)', {
          locationId,
          recipient: recipient.email,
          state,
        });
        return;
      }
      // Three independent channels, each owns its try/catch and its own
      // alerts row. Promise.all is safe here precisely because no channel
      // function throws — failures are caught and persisted as failed rows.
      await Promise.all([
        dispatchEmail(recipient),
        dispatchSms(recipient),
        dispatchWhatsApp(recipient),
      ]);
    });
  } catch (error) {
    alertLogger.error('Failed to dispatch alerts', {
      locationId,
      state,
      error: (error as Error).message,
    });
  }
}

/**
 * Org-level "EUMETSAT feed degraded / restored" digest. Fires from the risk
 * engine instead of the per-location alert path so a 50-location tenant
 * gets ONE outage email and ONE recovery email per feed event, not 50 of
 * each.
 *
 * Throttled per-org via the alerts table: a second `feed-degraded` row
 * inside `throttleMin` (default 60, env-tunable via FEED_NOTICE_THROTTLE_MIN)
 * is suppressed. This bounds spam during a flaky feed without needing new
 * schema for "last notified" state.
 *
 * The audit row written below uses `anchorLocationId` / `anchorStateId`
 * purely as FK anchors — the alerts table requires non-null FKs but the
 * notice itself is conceptually org-level. We pick the first affected
 * location of the bucket; nothing in the email body references it.
 */
export interface FeedHealthNoticeInput {
  orgId: string;
  kind: 'degraded' | 'recovered';
  anchorLocationId: string;
  anchorStateId: number;
  /** How many of this org's locations transitioned this tick. */
  affectedCount: number;
  throttleMin?: number;
}

export interface FeedHealthNoticeResult {
  sent: boolean;
  reason?: 'throttled' | 'no-admins' | 'send-failed';
}

function buildFeedHealthHtml(kind: 'degraded' | 'recovered', affectedCount: number): string {
  const noun = affectedCount === 1 ? 'location' : 'locations';
  const titleColor = kind === 'degraded' ? '#d32f2f' : '#2e7d32';
  const headline =
    kind === 'degraded'
      ? '⚠️ EUMETSAT lightning feed degraded'
      : '✅ EUMETSAT lightning feed restored';
  const body =
    kind === 'degraded'
      ? `<p>The MTG-LI lightning data feed has stopped delivering recent products.
<strong>${affectedCount} ${noun}</strong> in your organisation has flipped to <strong>NO DATA FEED</strong>;
risk cannot be evaluated until the feed recovers. The dashboard will show the
locations as gray until then.</p>
<p>This is a single org-level notice; you won't receive a per-location email
for the same outage.</p>`
      : `<p>The MTG-LI feed is delivering recent products again.
<strong>${affectedCount} ${noun}</strong> in your organisation has resumed normal monitoring.</p>
<p>You're receiving this because at least one of your locations cleared back
to ALL CLEAR silently. Locations that recovered into STOP / HOLD / PREPARE
already triggered their own per-location alerts.</p>`;
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#222;max-width:560px;margin:0 auto;padding:16px">
<h2 style="color:${titleColor};margin:0 0 12px">${headline}</h2>
${body}
<hr style="border:0;border-top:1px solid #eee;margin:20px 0">
<p style="font-size:12px;color:#888">FlashAware automated notice — sent to organisation admins only. To change who receives these, update admin role assignments under Users.</p>
</body></html>`;
}

export async function dispatchFeedHealthNotice(
  opts: FeedHealthNoticeInput,
): Promise<FeedHealthNoticeResult> {
  const throttleMin =
    opts.throttleMin ?? parseInt(process.env.FEED_NOTICE_THROTTLE_MIN || '60', 10);
  const alertType = opts.kind === 'degraded' ? 'feed-degraded' : 'feed-recovered';
  const now = DateTime.utc().toISO()!;

  const recent = await hasRecentOrgFeedNotice(opts.orgId, alertType, throttleMin);
  if (recent) {
    alertLogger.info('Feed health notice throttled', {
      orgId: opts.orgId,
      kind: opts.kind,
      throttleMin,
      affectedCount: opts.affectedCount,
    });
    return { sent: false, reason: 'throttled' };
  }

  const adminEmails = await getOrgAdminEmails(opts.orgId);
  if (adminEmails.length === 0) {
    // Still write the audit row so the throttle window engages — without it
    // every tick during an outage would re-query for admins and re-log.
    await addAlert({
      location_id: opts.anchorLocationId,
      state_id: opts.anchorStateId,
      alert_type: alertType,
      recipient: 'org-admins',
      sent_at: now,
      delivered_at: null,
      acknowledged_at: null,
      acknowledged_by: null,
      escalated: false,
      error: 'no-admins-configured',
      twilio_sid: null,
      ack_token: null,
      ack_token_expires_at: null,
    });
    alertLogger.warn('Feed health notice skipped — no org admins', {
      orgId: opts.orgId,
      kind: opts.kind,
    });
    return { sent: false, reason: 'no-admins' };
  }

  const settings = await getOrgSettingsCached(opts.orgId);
  const fromAddress =
    settings['alert_from_address'] || process.env.ALERT_FROM || 'alerts@flashaware.io';
  const subject =
    opts.kind === 'degraded'
      ? `⚠️ FlashAware — EUMETSAT feed degraded (${opts.affectedCount} ${opts.affectedCount === 1 ? 'location' : 'locations'} affected)`
      : `✅ FlashAware — EUMETSAT feed restored (${opts.affectedCount} ${opts.affectedCount === 1 ? 'location' : 'locations'} resumed)`;
  const html = buildFeedHealthHtml(opts.kind, opts.affectedCount);

  let error: string | null = null;
  try {
    await getTransporter().sendMail({
      from: fromAddress,
      to: adminEmails.join(','),
      subject,
      html,
    });
  } catch (err) {
    error = (err as Error).message;
    alertLogger.error('Failed to send feed health notice', {
      orgId: opts.orgId,
      kind: opts.kind,
      error,
    });
  }

  // Write the audit row regardless of send success, so a transient SMTP
  // failure doesn't unthrottle: we'll try again after `throttleMin` instead
  // of on the next tick.
  await addAlert({
    location_id: opts.anchorLocationId,
    state_id: opts.anchorStateId,
    alert_type: alertType,
    recipient: adminEmails.join(','),
    sent_at: now,
    delivered_at: error ? null : now,
    acknowledged_at: null,
    acknowledged_by: null,
    escalated: false,
    error,
    twilio_sid: null,
    ack_token: null,
    ack_token_expires_at: null,
  });

  if (error) return { sent: false, reason: 'send-failed' };

  alertLogger.info('Feed health notice dispatched', {
    orgId: opts.orgId,
    kind: opts.kind,
    affectedCount: opts.affectedCount,
    adminCount: adminEmails.length,
  });
  return { sent: true };
}

let escalationCheckRunning = false;

export interface EscalationGroup {
  location_id: string;
  state_id: number;
  /** All sibling rows (every channel) for this missed event, oldest first. */
  alerts: AlertRecord[];
  /** Driver row used to time the escalation — the oldest unacked sibling. */
  driver: AlertRecord;
}

/**
 * Bucket unacknowledged alert rows by `(location_id, state_id)` so a STOP
 * that fired to email + SMS + WhatsApp escalates ONCE rather than three
 * times. Skips:
 *   * `alert_type='system'` — the leading audit row, never delivered.
 *   * `escalated=true` — already handled in a previous cycle.
 * Pure / exported for unit testing without a DB.
 *
 * Channel-broadening is the second half of this fix: previously the loop
 * only escalated `alert_type='email'`, which meant an SMS-only or
 * WhatsApp-only recipient never escalated when unacked. After the
 * broadening, *any* missed event (regardless of which channel was
 * configured) escalates once, with all sibling rows marked escalated
 * together so the next cycle doesn't re-fire.
 */
export function groupAlertsForEscalation(rows: AlertRecord[]): EscalationGroup[] {
  const buckets = new Map<string, AlertRecord[]>();
  for (const a of rows) {
    if (a.escalated) continue;
    if (a.alert_type === 'system') continue;
    if (a.state_id == null) continue;
    const key = `${a.location_id} ${a.state_id}`;
    const arr = buckets.get(key);
    if (arr) arr.push(a);
    else buckets.set(key, [a]);
  }
  const out: EscalationGroup[] = [];
  for (const alerts of buckets.values()) {
    alerts.sort((a, b) => {
      const ta = a.sent_at ? Date.parse(a.sent_at) : 0;
      const tb = b.sent_at ? Date.parse(b.sent_at) : 0;
      return ta - tb;
    });
    out.push({
      location_id: alerts[0].location_id,
      state_id: Number(alerts[0].state_id),
      alerts,
      driver: alerts[0],
    });
  }
  return out;
}

export async function checkEscalations(): Promise<void> {
  if (escalationCheckRunning) {
    alertLogger.warn('Skipping escalation check — previous run still in progress');
    return;
  }
  escalationCheckRunning = true;
  try {
    // Pull every unack row older than 1 minute, then group by (location_id,
    // state_id). One escalation per missed event, even if email + SMS +
    // WhatsApp all failed — admins shouldn't get three pages for one storm.
    const { getUnacknowledgedAlerts: getUnack } = await import('./queries');
    const unacknowledgedAlerts = await getUnack(1);
    const groups = groupAlertsForEscalation(unacknowledgedAlerts);

    for (const group of groups) {
      const { driver, alerts } = group;

      // Resolve the alert's org and read its escalation config.
      const orgId = await getOrgIdForLocation(driver.location_id);
      if (!orgId) continue;
      const orgSettings = await getOrgSettingsCached(orgId);
      if (orgSettings['escalation_enabled'] === 'false') continue;
      const delayMin = parseInt(orgSettings['escalation_delay_min'] || '10', 10);

      // Has enough time elapsed under this org's policy?
      const sentAt = driver.sent_at ? new Date(driver.sent_at).getTime() : null;
      if (!sentAt || Date.now() - sentAt < delayMin * 60_000) continue;

      // Mark every sibling escalated FIRST so concurrent cycles can't
      // double-escalate, and so a send failure below doesn't leave us
      // looping. If the org has email globally disabled there's no
      // transport for the escalation — we still mark to stop the retry.
      //
      // Race safety: escalateAlert is gated on `escalated = false` and only
      // returns true when THIS call was the one that flipped the row. The
      // driver row's flip determines whether we send: if a concurrent
      // checkEscalations on another machine (e.g. mid-leader-handover) won
      // the driver flip, we lost the race and must not double-send. Sibling
      // flips are best-effort cleanup — every sibling we managed to flip
      // tells the next cycle to skip the row, but the send decision hangs
      // off the driver alone.
      const siblingIds = alerts.map((a) => a.id);
      const flipResults = await Promise.all(siblingIds.map((id) => escalateAlert(id)));
      const driverIdx = siblingIds.indexOf(driver.id);
      const wonDriverFlip = driverIdx >= 0 && flipResults[driverIdx];
      if (!wonDriverFlip) {
        alertLogger.info('Escalation skipped — lost race for driver row', {
          alertIds: siblingIds,
          driverId: driver.id,
          orgId,
        });
        continue;
      }

      if (orgSettings['email_enabled'] === 'false') {
        alertLogger.info('Escalation suppressed — email disabled for org', {
          alertIds: siblingIds,
          orgId,
        });
        continue;
      }

      alertLogger.warn('Escalating unacknowledged event', {
        alertIds: siblingIds,
        driverChannel: driver.alert_type,
        sentAt: driver.sent_at,
        orgId,
        delayMin,
      });

      try {
        const adminEmails = await getOrgAdminEmails(orgId);
        if (adminEmails.length > 0) {
          const location = await getLocationById(driver.location_id);
          const locationName = location?.name || driver.location_id;
          // Build a recipient summary: distinct addresses across every
          // sibling channel, so the escalation email tells admins which
          // people couldn't be reached, not just which channels.
          const recipientSummary = Array.from(
            new Set(alerts.map((a) => a.recipient).filter((r) => r && r !== 'system')),
          ).join(', ');
          const escalationHtml = buildEscalationHtml({
            locationName,
            recipientEmail: recipientSummary || driver.recipient,
            alertId: driver.id,
            sentAt: driver.sent_at,
            delayMin,
          });
          await getTransporter().sendMail({
            from:
              orgSettings['alert_from_address'] || process.env.ALERT_FROM || 'alerts@flashaware.io',
            to: adminEmails.join(','),
            subject: `⚠️ ESCALATION — Unacknowledged alert for ${locationName} (event #${driver.state_id})`,
            html: escalationHtml,
          });
          alertLogger.info('Escalation email sent', {
            alertIds: siblingIds,
            locationName,
            adminEmails,
          });
        }
      } catch (escalationSendError) {
        alertLogger.error('Failed to send escalation email', {
          alertIds: siblingIds,
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

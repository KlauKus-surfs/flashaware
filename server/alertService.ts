import { createTransport } from 'nodemailer';
import twilio from 'twilio';
import {
  getLocationRecipients,
  getAlerts,
  acknowledgeAlert as acknowledgeAlertDb,
  escalateAlert,
  addAlert,
  getAllRiskStates,
  getLocationById,
  getAppSettings,
  getOrgSettings,
  getOrgAdminEmails,
  getOrgIdForLocation,
} from './queries';
import { DateTime } from 'luxon';
import { alertLogger } from './logger';
import { wsManager } from './websocket';

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

function buildSmsBody(locationName: string, state: string, reason: string): string {
  const info = STATE_LABELS[state] || STATE_LABELS.DEGRADED;
  const shortReason = reason.length > 120 ? reason.substring(0, 117) + '...' : reason;
  return `${info.emoji} FlashAware ${state} — ${locationName}\n${shortReason}\nflashaware.com`;
}

function buildWhatsAppBody(locationName: string, state: string, reason: string): string {
  const info = STATE_LABELS[state] || STATE_LABELS.DEGRADED;
  const shortReason = reason.length > 500 ? reason.substring(0, 497) + '...' : reason;
  return `*${info.emoji} FlashAware Alert*\n*${state}* — ${locationName}\n\n${shortReason}\n\n_${new Date().toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' })} SAST_\nflashaware.com`;
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

const STATE_LABELS: Record<string, { emoji: string; subject: string; color: string }> = {
  STOP: { emoji: '🔴', subject: 'STOP — Shelter Immediately', color: '#d32f2f' },
  HOLD: { emoji: '🟠', subject: 'HOLD — Remain Sheltered', color: '#ed6c02' },
  DEGRADED: { emoji: '⚠️', subject: 'NO DATA FEED — Risk Cannot Be Determined', color: '#9e9e9e' },
  PREPARE: { emoji: '🟡', subject: 'PREPARE — Heightened Risk', color: '#fbc02d' },
  ALL_CLEAR: { emoji: '🟢', subject: 'ALL CLEAR — Safe to Resume', color: '#2e7d32' },
};

export function buildEmailHtml(
  locationName: string,
  state: string,
  reason: string
): string {
  const info = STATE_LABELS[state] || STATE_LABELS.DEGRADED;
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: ${info.color}; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0;">${info.emoji} ${state}</h1>
        <h2 style="margin: 4px 0 0;">${locationName}</h2>
      </div>
      <div style="padding: 20px; background: #f5f5f5; border-radius: 0 0 8px 8px;">
        <p style="font-size: 16px;"><strong>Why:</strong> ${reason}</p>
        <p style="font-size: 14px; color: #666;">
          Time: ${new Date().toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' })} SAST
        </p>
        <hr style="border: none; border-top: 1px solid #ddd;">
        <p style="font-size: 12px; color: #999;">
          This is an automated alert from the FlashAware Decision System.
          Do not reply to this email. Log in to the dashboard to acknowledge this alert.
        </p>
      </div>
    </div>
  `;
}

export async function dispatchAlerts(
  locationId: string,
  stateId: bigint,
  state: string,
  reason: string
): Promise<void> {
  const info = STATE_LABELS[state] || STATE_LABELS.DEGRADED;
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
      : twilioSmsFrom ? `whatsapp:${twilioSmsFrom}` : null;

    // Check email-enabled setting — per-org override falls back to platform default.
    const settings = location?.org_id ? await getOrgSettings(location.org_id) : await getAppSettings();
    const emailEnabled = settings['email_enabled'] !== 'false';

    // Send email + SMS + WhatsApp to each recipient
    for (const recipient of recipients) {
      // --- Email (opt-in per recipient, also gated by per-org setting) ---
      const recipientWantsEmail = recipient.notify_email !== false; // default true
      if (emailEnabled && recipientWantsEmail) {
        try {
          const emailHtml = buildEmailHtml(locationName, state, reason);
          const fromAddress = settings['alert_from_address'] || process.env.ALERT_FROM || 'lightning-alerts@flashaware.local';
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
          });
          alertLogger.info('Email alert dispatched', { alertId, locationId, state, recipient: recipient.email });
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
          });
          alertLogger.error('Failed to send alert email', {
            locationId, state, recipient: recipient.email, error: (emailError as Error).message,
          });
        }
      } else if (!recipientWantsEmail) {
        alertLogger.info('Email skipped (recipient opted out)', { locationId, recipient: recipient.email });
      } else {
        alertLogger.info('Email skipped (globally disabled)', { locationId, recipient: recipient.email });
      }

      // --- SMS (opt-in per recipient + phone must be OTP-verified) ---
      if (recipient.phone && recipient.notify_sms && !recipient.phone_verified_at) {
        alertLogger.info('SMS skipped (phone not yet verified)', { locationId, recipient: recipient.phone });
      } else if (recipient.phone && recipient.notify_sms && recipient.phone_verified_at && twilioClient && twilioSmsFrom) {
        try {
          const smsBody = buildSmsBody(locationName, state, reason);
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
          });
          alertLogger.info('SMS alert dispatched', { smsAlertId, locationId, state, recipient: recipient.phone });
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
          });
          alertLogger.error('Failed to send SMS alert', {
            locationId, state, recipient: recipient.phone, error: (smsError as Error).message,
          });
        }
      }

      // --- WhatsApp (opt-in per recipient + phone must be OTP-verified) ---
      if (recipient.phone && recipient.notify_whatsapp && !recipient.phone_verified_at) {
        alertLogger.info('WhatsApp skipped (phone not yet verified)', { locationId, recipient: recipient.phone });
      } else if (recipient.phone && recipient.notify_whatsapp && recipient.phone_verified_at && twilioClient && twilioWhatsAppFrom) {
        const waTo = `whatsapp:${recipient.phone}`;
        // Use approved per-state template when available, else fall back to generic approved template
          const WA_TEMPLATE_SIDS: Record<string, string | undefined> = {
            STOP:      process.env.TWILIO_WA_TEMPLATE_STOP,
            PREPARE:   process.env.TWILIO_WA_TEMPLATE_PREPARE,
            HOLD:      process.env.TWILIO_WA_TEMPLATE_HOLD,
            ALL_CLEAR: process.env.TWILIO_WA_TEMPLATE_ALL_CLEAR,
            DEGRADED:  process.env.TWILIO_WA_TEMPLATE_DEGRADED,
          };
          const stateTemplateSid = WA_TEMPLATE_SIDS[state];
          const templateSid = stateTemplateSid || process.env.TWILIO_WHATSAPP_TEMPLATE_SID;
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
                body: buildWhatsAppBody(locationName, state, reason),
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
            const isTemplateFail = code === 63016 || code === 63032 || String(templateErr?.message).includes('63016') || String(templateErr?.message).includes('63032');
            if (isTemplateFail && templateSid) {
              alertLogger.warn('WhatsApp template rejected, retrying as freeform', { code, recipient: recipient.phone });
              try {
                waMsg = await twilioClient.messages.create({
                  body: buildWhatsAppBody(locationName, state, reason),
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
            });
            alertLogger.info('WhatsApp alert dispatched', { waAlertId, locationId, state, recipient: recipient.phone, twilioSid: waMsg.sid });
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
            });
            alertLogger.error('Failed to send WhatsApp alert', { locationId, state, recipient: recipient.phone, error: waErrMsg });
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

export async function acknowledgeAlert(
  alertId: string,
  acknowledgedBy: string
): Promise<boolean> {
  const id = parseInt(alertId, 10);
  const success = await acknowledgeAlertDb(id, acknowledgedBy);
  
  if (success) {
    alertLogger.info('Alert acknowledged', { alertId: id, acknowledgedBy });
  } else {
    alertLogger.warn('Failed to acknowledge alert', { alertId: id, acknowledgedBy });
  }
  
  return success;
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
          const escalationHtml = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background: #b71c1c; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
                <h1 style="margin: 0;">⚠️ ESCALATION — Unacknowledged Alert</h1>
                <h2 style="margin: 4px 0 0;">${locationName}</h2>
              </div>
              <div style="padding: 20px; background: #f5f5f5; border-radius: 0 0 8px 8px;">
                <p style="font-size: 16px;">An alert sent to <strong>${alert.recipient}</strong> has not been acknowledged after ${delayMin} minutes.</p>
                <p style="font-size: 14px; color: #666;">Alert ID: ${alert.id} | Sent: ${alert.sent_at}</p>
                <p style="font-size: 14px;">Please log in to the FlashAware dashboard to review and acknowledge this alert immediately.</p>
                <hr style="border: none; border-top: 1px solid #ddd;">
                <p style="font-size: 12px; color: #999;">This escalation was sent automatically by FlashAware.</p>
              </div>
            </div>
          `;
          await getTransporter().sendMail({
            from: orgSettings['alert_from_address'] || process.env.ALERT_FROM || 'alerts@flashaware.io',
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

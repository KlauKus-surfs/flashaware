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

// Email transport configuration
export const transporter = createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false, // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Verify email configuration on startup
transporter.verify((error, success) => {
  if (error) {
    alertLogger.error('Email transport configuration failed', { error: error.message });
  } else {
    alertLogger.info('Email transport is ready');
  }
});

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

    // Send email + SMS + WhatsApp to each recipient
    for (const recipient of recipients) {
      // --- Email ---
      try {
        const emailHtml = buildEmailHtml(locationName, state, reason);
        await transporter.sendMail({
          from: process.env.ALERT_FROM || 'lightning-alerts@flashaware.local',
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
        });
        alertLogger.error('Failed to send alert email', {
          locationId, state, recipient: recipient.email, error: (emailError as Error).message,
        });
      }

      // --- SMS (opt-in per recipient) ---
      if (recipient.phone && recipient.notify_sms && twilioClient && twilioSmsFrom) {
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
          });
          alertLogger.error('Failed to send SMS alert', {
            locationId, state, recipient: recipient.phone, error: (smsError as Error).message,
          });
        }
      }

      // --- WhatsApp (opt-in per recipient) ---
      if (recipient.phone && recipient.notify_whatsapp && twilioClient && twilioWhatsAppFrom) {
        const waTo = `whatsapp:${recipient.phone}`;
        try {
          const templateSid = process.env.TWILIO_WHATSAPP_TEMPLATE_SID;
          const info = STATE_LABELS[state] || STATE_LABELS.DEGRADED;
          const actionMsg = reason.length > 200 ? reason.substring(0, 197) + '...' : reason;
          const messageParams = templateSid
            ? {
                from: twilioWhatsAppFrom,
                to: waTo,
                contentSid: templateSid,
                contentVariables: JSON.stringify({ '1': locationName, '2': `${info.emoji} ${state}`, '3': actionMsg }),
              }
            : {
                body: buildWhatsAppBody(locationName, state, reason),
                from: twilioWhatsAppFrom,
                to: waTo,
              };
          await twilioClient.messages.create(messageParams as any);
          const waAlertId = await addAlert({
            location_id: locationId,
            state_id: Number(stateId),
            alert_type: 'whatsapp',
            recipient: recipient.phone,
            sent_at: now,
            delivered_at: now,
            acknowledged_at: null,
            acknowledged_by: null,
            escalated: false,
            error: null,
          });
          alertLogger.info('WhatsApp alert dispatched', { waAlertId, locationId, state, recipient: recipient.phone });
        } catch (waError) {
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
            error: (waError as Error).message,
          });
          alertLogger.error('Failed to send WhatsApp alert', {
            locationId, state, recipient: recipient.phone, error: (waError as Error).message,
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

export async function checkEscalations(): Promise<void> {
  try {
    const unacknowledgedAlerts = await getUnacknowledgedAlerts(5);
    
    for (const alert of unacknowledgedAlerts) {
      if (alert.alert_type === 'email' && !alert.escalated) {
        alertLogger.warn('Alert requires escalation', {
          alertId: alert.id,
          recipient: alert.recipient,
          sentAt: alert.sent_at,
        });
        
        await escalateAlert(alert.id);
        
        // TODO: Implement escalation logic (e.g., send to supervisor, SMS, etc.)
        // For now, just mark as escalated
      }
    }
  } catch (error) {
    alertLogger.error('Error checking escalations', { error: (error as Error).message });
  }
}

async function getUnacknowledgedAlerts(olderThanMinutes: number = 5) {
  // Import the function from queries.ts
  const { getUnacknowledgedAlerts: getUnack } = await import('./queries');
  return getUnack(olderThanMinutes);
}

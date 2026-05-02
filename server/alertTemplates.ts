// Pure message-body builders for alerts. No I/O, no DB, no Twilio — just
// strings in, strings out. Split out of alertService.ts so the templates can
// be unit-tested without mocking transports, and so adding a new channel
// doesn't drag delivery code along with it.

export interface StateInfo {
  emoji: string;
  subject: string;
  color: string;
}

export const STATE_LABELS: Record<string, StateInfo> = {
  STOP: { emoji: '🔴', subject: 'STOP — Shelter Immediately', color: '#d32f2f' },
  HOLD: { emoji: '🟠', subject: 'HOLD — Remain Sheltered', color: '#ed6c02' },
  DEGRADED: { emoji: '⚠️', subject: 'NO DATA FEED — Risk Cannot Be Determined', color: '#9e9e9e' },
  PREPARE: { emoji: '🟡', subject: 'PREPARE — Heightened Risk', color: '#fbc02d' },
  ALL_CLEAR: { emoji: '🟢', subject: 'ALL CLEAR — Safe to Resume', color: '#2e7d32' },
};

export function getStateInfo(state: string): StateInfo {
  return STATE_LABELS[state] || STATE_LABELS.DEGRADED;
}

// SAST-locked timestamp string (operations are South Africa).
function nowSast(): string {
  return new Date().toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' });
}

export function buildSmsBody(
  locationName: string,
  state: string,
  reason: string,
  ackUrl?: string,
): string {
  const info = getStateInfo(state);
  const shortReason = reason.length > 120 ? reason.substring(0, 117) + '...' : reason;
  const ackLine = ackUrl ? `\nAck: ${ackUrl}` : '';
  return `${info.emoji} FlashAware ${state} — ${locationName}\n${shortReason}${ackLine}\nflashaware.com`;
}

export function buildWhatsAppBody(
  locationName: string,
  state: string,
  reason: string,
  ackUrl?: string,
): string {
  const info = getStateInfo(state);
  const shortReason = reason.length > 500 ? reason.substring(0, 497) + '...' : reason;
  const ackLine = ackUrl ? `\n\n*Acknowledge:* ${ackUrl}` : '';
  return `*${info.emoji} FlashAware Alert*\n*${state}* — ${locationName}\n\n${shortReason}${ackLine}\n\n_${nowSast()} SAST_\nflashaware.com`;
}

export function buildEmailHtml(
  locationName: string,
  state: string,
  reason: string,
  ackUrl?: string,
): string {
  const info = getStateInfo(state);
  const ackButton = ackUrl
    ? `
        <div style="text-align: center; margin: 18px 0;">
          <a href="${ackUrl}" style="background: ${info.color}; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">
            Acknowledge alert
          </a>
        </div>
        <p style="font-size: 12px; color: #666; text-align: center;">
          Or log in at <a href="https://flashaware.com" style="color: #666;">flashaware.com</a> to view the dashboard.
        </p>
      `
    : '';
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: ${info.color}; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0;">${info.emoji} ${state}</h1>
        <h2 style="margin: 4px 0 0;">${locationName}</h2>
      </div>
      <div style="padding: 20px; background: #f5f5f5; border-radius: 0 0 8px 8px;">
        <p style="font-size: 16px;"><strong>Why:</strong> ${reason}</p>
        <p style="font-size: 14px; color: #666;">
          Time: ${nowSast()} SAST
        </p>${ackButton}
        <hr style="border: none; border-top: 1px solid #ddd;">
        <p style="font-size: 12px; color: #999;">
          This is an automated alert from the FlashAware Decision System.
          Do not reply to this email. Log in to the dashboard to acknowledge this alert.
        </p>
      </div>
    </div>
  `;
}

export interface EscalationParams {
  locationName: string;
  recipientEmail: string;
  alertId: number | string;
  sentAt: string | null;
  delayMin: number;
}

export function buildEscalationHtml(p: EscalationParams): string {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #b71c1c; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0;">⚠️ ESCALATION — Unacknowledged Alert</h1>
        <h2 style="margin: 4px 0 0;">${p.locationName}</h2>
      </div>
      <div style="padding: 20px; background: #f5f5f5; border-radius: 0 0 8px 8px;">
        <p style="font-size: 16px;">An alert sent to <strong>${p.recipientEmail}</strong> has not been acknowledged after ${p.delayMin} minutes.</p>
        <p style="font-size: 14px; color: #666;">Alert ID: ${p.alertId} | Sent: ${p.sentAt}</p>
        <p style="font-size: 14px;">Please log in to the FlashAware dashboard to review and acknowledge this alert immediately.</p>
        <hr style="border: none; border-top: 1px solid #ddd;">
        <p style="font-size: 12px; color: #999;">This escalation was sent automatically by FlashAware.</p>
      </div>
    </div>
  `;
}

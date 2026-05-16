// Pure message-body builders for alerts. No I/O, no DB, no Twilio — just
// strings in, strings out. Split out of alertService.ts so the templates can
// be unit-tested without mocking transports, and so adding a new channel
// doesn't drag delivery code along with it.

// HTML-escape every user-supplied string before interpolating it into an
// email body. Without this, a `locationName` of "</h2><script src=…></script>"
// — admin-supplied and only validated for length — gets rendered as live
// markup inside outbound mail. `reason` is server-built today, but the
// generator pulls trend strings and numeric values from upstream code; we
// escape it anyway so a future change can't introduce a stored-XSS by
// accident. Mirror the encoding of `&` first so we don't double-escape the
// later substitutions.
export function escapeHtml(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// URLs go into href= attributes. encodeURI keeps the URL navigable while
// neutralising any embedded quotes or angle brackets that would let an
// attacker break out of the attribute. We don't allow javascript: URIs to
// reach this point — every caller passes either ACK_BASE_URL/<token> or an
// app-base URL — but the encoder defends against any future drift.
function escapeAttr(s: string): string {
  return encodeURI(s).replace(/"/g, '%22');
}

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

// Reason object JSONB schema from risk_states. May contain LFL-style flash counts
// or AFA-style lit-pixel/incidence counts depending on `source`.
export interface ReasonObject {
  reason: string;
  flashes_in_stop_radius?: number;
  flashes_in_prepare_radius?: number;
  lit_pixels_stop?: number;
  lit_pixels_prepare?: number;
  incidence_stop?: number;
  incidence_prepare?: number;
  nearestFlashKm?: number | null;
  dataAgeSec?: number;
  trend?: string;
  source?: 'lfl' | 'afa';
}

// Build human-readable alert body based on reason object source.
// If source === 'afa', render lit-pixel/incidence phrasing.
// Otherwise (missing source or 'lfl'), render flash-count phrasing (backwards compat).
function buildReasonText(
  state: string,
  stop_radius_km: number,
  prepare_radius_km: number,
  stop_window_min: number,
  prepare_window_min: number,
  reason: ReasonObject,
): string {
  const source = reason.source || 'lfl';

  // AFA-style phrasing when source === 'afa'
  if (source === 'afa') {
    if (state === 'STOP') {
      const stopBullet =
        reason.lit_pixels_stop !== undefined || reason.incidence_stop !== undefined
          ? `${reason.lit_pixels_stop ?? 0} cell(s) lit within ${stop_radius_km} km in last ${stop_window_min} min (${reason.incidence_stop ?? 0} flash-pixel hits)`
          : reason.reason;
      return stopBullet;
    }
    if (state === 'HOLD') {
      const holdBullet =
        reason.lit_pixels_prepare !== undefined
          ? `STOP cleared but ${reason.lit_pixels_prepare} cell(s) still lit within ${prepare_radius_km} km`
          : reason.reason;
      return holdBullet;
    }
    if (state === 'PREPARE') {
      const prepareBullet =
        reason.lit_pixels_prepare !== undefined || reason.incidence_prepare !== undefined
          ? `${reason.lit_pixels_prepare ?? 0} cell(s) lit within ${prepare_radius_km} km in last ${prepare_window_min} min (${reason.incidence_prepare ?? 0} flash-pixel hits)`
          : reason.reason;
      return prepareBullet;
    }
    if (state === 'ALL_CLEAR') {
      const clearBullet =
        reason.lit_pixels_prepare !== undefined
          ? `No cells lit within ${prepare_radius_km} km in last ${prepare_window_min} min`
          : reason.reason;
      return clearBullet;
    }
  }

  // LFL-style phrasing (default/backwards compat)
  if (state === 'STOP') {
    const stopBullet =
      reason.flashes_in_stop_radius !== undefined
        ? `${reason.flashes_in_stop_radius} flash(es) within ${stop_radius_km} km in last ${stop_window_min} min`
        : reason.reason;
    return stopBullet;
  }
  if (state === 'HOLD') {
    const holdBullet =
      reason.flashes_in_prepare_radius !== undefined
        ? `${reason.flashes_in_prepare_radius} flash(es) within ${prepare_radius_km} km in last ${prepare_window_min} min. STOP conditions no longer met but threat persists`
        : reason.reason;
    return holdBullet;
  }
  if (state === 'PREPARE') {
    const prepareBullet =
      reason.flashes_in_prepare_radius !== undefined
        ? `${reason.flashes_in_prepare_radius} flash(es) within ${prepare_radius_km} km in last ${prepare_window_min} min`
        : reason.reason;
    return prepareBullet;
  }
  if (state === 'ALL_CLEAR') {
    const clearBullet =
      reason.flashes_in_stop_radius !== undefined
        ? `No flashes within ${prepare_radius_km} km in last ${prepare_window_min} min`
        : reason.reason;
    return clearBullet;
  }

  // Fallback
  return reason.reason;
}

export function buildSmsBody(
  locationName: string,
  state: string,
  reason: string | ReasonObject,
  ackUrl?: string,
  stop_radius_km?: number,
  prepare_radius_km?: number,
  stop_window_min?: number,
  prepare_window_min?: number,
): string {
  const info = getStateInfo(state);

  // Extract reason text from object or use string directly
  let reasonText: string;
  if (typeof reason === 'string') {
    reasonText = reason;
  } else {
    // ReasonObject
    reasonText = buildReasonText(
      state,
      stop_radius_km ?? 50,
      prepare_radius_km ?? 100,
      stop_window_min ?? 10,
      prepare_window_min ?? 30,
      reason,
    );
  }

  const shortReason = reasonText.length > 120 ? reasonText.substring(0, 117) + '...' : reasonText;
  const ackLine = ackUrl ? `\nAck: ${ackUrl}` : '';
  return `${info.emoji} FlashAware ${state} — ${locationName}\n${shortReason}${ackLine}\nflashaware.com`;
}

export function buildWhatsAppBody(
  locationName: string,
  state: string,
  reason: string | ReasonObject,
  ackUrl?: string,
  stop_radius_km?: number,
  prepare_radius_km?: number,
  stop_window_min?: number,
  prepare_window_min?: number,
): string {
  const info = getStateInfo(state);

  // Extract reason text from object or use string directly
  let reasonText: string;
  if (typeof reason === 'string') {
    reasonText = reason;
  } else {
    // ReasonObject
    reasonText = buildReasonText(
      state,
      stop_radius_km ?? 50,
      prepare_radius_km ?? 100,
      stop_window_min ?? 10,
      prepare_window_min ?? 30,
      reason,
    );
  }

  const shortReason = reasonText.length > 500 ? reasonText.substring(0, 497) + '...' : reasonText;
  const ackLine = ackUrl ? `\n\n*Acknowledge:* ${ackUrl}` : '';
  return `*${info.emoji} FlashAware Alert*\n*${state}* — ${locationName}\n\n${shortReason}${ackLine}\n\n_${nowSast()} SAST_\nflashaware.com`;
}

export function buildEmailHtml(
  locationName: string,
  state: string,
  reason: string | ReasonObject,
  ackUrl?: string,
  stop_radius_km?: number,
  prepare_radius_km?: number,
  stop_window_min?: number,
  prepare_window_min?: number,
): string {
  const info = getStateInfo(state);

  // Extract reason text from object or use string directly
  let reasonText: string;
  if (typeof reason === 'string') {
    reasonText = reason;
  } else {
    // ReasonObject
    reasonText = buildReasonText(
      state,
      stop_radius_km ?? 50,
      prepare_radius_km ?? 100,
      stop_window_min ?? 10,
      prepare_window_min ?? 30,
      reason,
    );
  }

  // info.* fields are read from a closed enum (STATE_LABELS), so they're
  // already safe — but we escape state too because it's passed in as a string
  // from the engine and a future bad value shouldn't break the markup.
  const safeName = escapeHtml(locationName);
  const safeState = escapeHtml(state);
  const safeReason = escapeHtml(reasonText);
  const safeEmoji = escapeHtml(info.emoji);
  const ackButton = ackUrl
    ? `
        <div style="text-align: center; margin: 18px 0;">
          <a href="${escapeAttr(ackUrl)}" style="background: ${info.color}; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">
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
        <h1 style="margin: 0;">${safeEmoji} ${safeState}</h1>
        <h2 style="margin: 4px 0 0;">${safeName}</h2>
      </div>
      <div style="padding: 20px; background: #f5f5f5; border-radius: 0 0 8px 8px;">
        <p style="font-size: 16px;"><strong>Why:</strong> ${safeReason}</p>
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
  // recipientEmail comes from the location_recipients row — admin-controlled,
  // not validated for HTML. locationName is the same admin-controlled string
  // as in buildEmailHtml. delayMin / alertId / sentAt are server-built but
  // escape them for consistency.
  const safeName = escapeHtml(p.locationName);
  const safeRecipient = escapeHtml(p.recipientEmail);
  const safeAlertId = escapeHtml(p.alertId);
  const safeSentAt = escapeHtml(p.sentAt);
  const safeDelay = escapeHtml(p.delayMin);
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #b71c1c; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0;">⚠️ ESCALATION — Unacknowledged Alert</h1>
        <h2 style="margin: 4px 0 0;">${safeName}</h2>
      </div>
      <div style="padding: 20px; background: #f5f5f5; border-radius: 0 0 8px 8px;">
        <p style="font-size: 16px;">An alert sent to <strong>${safeRecipient}</strong> has not been acknowledged after ${safeDelay} minutes.</p>
        <p style="font-size: 14px; color: #666;">Alert ID: ${safeAlertId} | Sent: ${safeSentAt}</p>
        <p style="font-size: 14px;">Please log in to the FlashAware dashboard to review and acknowledge this alert immediately.</p>
        <hr style="border: none; border-top: 1px solid #ddd;">
        <p style="font-size: 12px; color: #999;">This escalation was sent automatically by FlashAware.</p>
      </div>
    </div>
  `;
}

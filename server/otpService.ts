import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { logger } from './logger';
import {
  countRecentOtpSendsForRecipient,
  oldestRecentOtpSendForRecipient,
  insertPhoneOtp,
  getActivePhoneOtp,
  incrementPhoneOtpAttempts,
  markPhoneOtpVerified,
  markRecipientPhoneVerified,
} from './queries';

// One-time codes for verifying recipient phone numbers before we'll dispatch
// SMS or WhatsApp alerts to them. Without this gate, anyone with admin access
// to any tenant could weaponize our Twilio account against arbitrary numbers.

const OTP_TTL_MIN = 10;
const OTP_LENGTH = 6;
const MAX_SENDS_PER_HOUR = 3;
const MAX_VERIFY_ATTEMPTS = 5;

function generateCode(): string {
  // crypto.randomInt is uniform across [min, max). 6 digits, zero-padded.
  const n = crypto.randomInt(0, 10 ** OTP_LENGTH);
  return n.toString().padStart(OTP_LENGTH, '0');
}

export interface SendOtpResult {
  ok: boolean;
  reason?: 'rate_limited' | 'twilio_disabled' | 'send_failed';
  error?: string;
  retry_at?: string; // ISO — present when rate_limited
}

/**
 * Generate a code, hash it, store it, and SMS the plaintext to `phone`. Returns
 * { ok: true } on success. Caller is responsible for validating that the
 * recipient + phone exist and that the user is allowed to act on them.
 */
export async function sendPhoneOtp(recipientId: number, phone: string): Promise<SendOtpResult> {
  const recentSends = await countRecentOtpSendsForRecipient(recipientId, 60);
  if (recentSends >= MAX_SENDS_PER_HOUR) {
    const oldest = await oldestRecentOtpSendForRecipient(recipientId, 60);
    // Window is rolling 60 minutes; user can try again 60min after the oldest send.
    const retryAt = oldest
      ? new Date(oldest.getTime() + 60 * 60_000)
      : new Date(Date.now() + 60 * 60_000);
    logger.warn('OTP send rate-limited', {
      recipientId,
      recentSends,
      retryAt: retryAt.toISOString(),
    });
    return { ok: false, reason: 'rate_limited', retry_at: retryAt.toISOString() };
  }

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  if (!sid || !token || !from) {
    return { ok: false, reason: 'twilio_disabled', error: 'SMS provider not configured' };
  }

  const code = generateCode();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + OTP_TTL_MIN * 60_000);
  await insertPhoneOtp(recipientId, phone, codeHash, expiresAt);

  try {
    const twilio = (await import('twilio')).default;
    const client = twilio(sid, token);
    await client.messages.create({
      from,
      to: phone,
      body: `FlashAware verification code: ${code}. Expires in ${OTP_TTL_MIN} minutes. If you did not request this, ignore this message.`,
    });
    logger.info('OTP sent', { recipientId, phone });
    return { ok: true };
  } catch (err) {
    logger.error('OTP send failed', { recipientId, phone, error: (err as Error).message });
    return { ok: false, reason: 'send_failed', error: (err as Error).message };
  }
}

export interface VerifyOtpResult {
  ok: boolean;
  reason?: 'no_active_otp' | 'too_many_attempts' | 'invalid_code';
  attempts_remaining?: number; // present on invalid_code; 0 means next try will lockout
}

/**
 * Verify a code against the latest active OTP for (recipient, phone). On
 * success: marks the OTP verified and the recipient.phone_verified_at = NOW().
 */
export async function verifyPhoneOtp(
  recipientId: number,
  phone: string,
  code: string,
): Promise<VerifyOtpResult> {
  const otp = await getActivePhoneOtp(recipientId, phone);
  if (!otp) return { ok: false, reason: 'no_active_otp' };

  if (otp.attempts >= MAX_VERIFY_ATTEMPTS) {
    return { ok: false, reason: 'too_many_attempts' };
  }

  const matches = await bcrypt.compare(code, otp.code_hash);
  if (!matches) {
    const newAttempts = await incrementPhoneOtpAttempts(otp.id);
    const remaining = Math.max(0, MAX_VERIFY_ATTEMPTS - newAttempts);
    return { ok: false, reason: 'invalid_code', attempts_remaining: remaining };
  }

  await markPhoneOtpVerified(otp.id);
  await markRecipientPhoneVerified(recipientId);
  logger.info('Phone verified via OTP', { recipientId, phone });
  return { ok: true };
}

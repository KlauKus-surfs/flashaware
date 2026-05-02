import { query, getOne } from '../db';

export interface RecipientPhoneOtpRecord {
  id: number;
  recipient_id: number;
  phone: string;
  code_hash: string;
  attempts: number;
  expires_at: string;
  verified_at: string | null;
  created_at: string;
}

/** Count OTPs created for this recipient since `since` (used for rate-limiting). */
export async function countRecentOtpSendsForRecipient(
  recipientId: number,
  sinceMinutes: number,
): Promise<number> {
  const r = await getOne<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM recipient_phone_otps
     WHERE recipient_id = $1 AND created_at >= NOW() - make_interval(mins => $2)`,
    [recipientId, sinceMinutes],
  );
  return parseInt(r?.c || '0', 10);
}

/** Returns the timestamp of the oldest OTP sent within `sinceMinutes` for this recipient,
 *  or null if no recent sends. Used to compute a retry-after window. */
export async function oldestRecentOtpSendForRecipient(
  recipientId: number,
  sinceMinutes: number,
): Promise<Date | null> {
  const r = await getOne<{ created_at: string }>(
    `SELECT created_at FROM recipient_phone_otps
     WHERE recipient_id = $1 AND created_at >= NOW() - make_interval(mins => $2)
     ORDER BY created_at ASC LIMIT 1`,
    [recipientId, sinceMinutes],
  );
  return r ? new Date(r.created_at) : null;
}

/** Insert a new OTP. The caller is responsible for hashing the code first. */
export async function insertPhoneOtp(
  recipientId: number,
  phone: string,
  codeHash: string,
  expiresAt: Date,
): Promise<number> {
  const r = await getOne<{ id: number }>(
    `INSERT INTO recipient_phone_otps (recipient_id, phone, code_hash, expires_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [recipientId, phone, codeHash, expiresAt],
  );
  if (!r) throw new Error('Failed to insert OTP');
  return r.id;
}

/** Latest unverified OTP that is still valid for this recipient + phone. */
export async function getActivePhoneOtp(
  recipientId: number,
  phone: string,
): Promise<RecipientPhoneOtpRecord | null> {
  return getOne<RecipientPhoneOtpRecord>(
    `SELECT * FROM recipient_phone_otps
     WHERE recipient_id = $1 AND phone = $2 AND verified_at IS NULL AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [recipientId, phone],
  );
}

export async function incrementPhoneOtpAttempts(otpId: number): Promise<number> {
  const r = await getOne<{ attempts: number }>(
    `UPDATE recipient_phone_otps SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts`,
    [otpId],
  );
  return r?.attempts ?? 0;
}

export async function markPhoneOtpVerified(otpId: number): Promise<void> {
  await query(`UPDATE recipient_phone_otps SET verified_at = NOW() WHERE id = $1`, [otpId]);
}

export async function markRecipientPhoneVerified(recipientId: number): Promise<void> {
  await query(`UPDATE location_recipients SET phone_verified_at = NOW() WHERE id = $1`, [
    recipientId,
  ]);
}

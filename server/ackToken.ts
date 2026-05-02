import { randomBytes } from 'crypto';

// 24 random bytes → 32 base64url characters → 192 bits of entropy.
// Brute-forcing the keyspace is not feasible.
const TOKEN_BYTES = 24;

// 48 hours from issuance — covers a Friday-evening storm where the
// on-duty operator clicks the link Monday morning. Long enough to be
// useful, short enough that stale links aren't a long-lived attack
// surface.
export const ACK_TOKEN_TTL_MS = 48 * 60 * 60 * 1000;

export function generateAckToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function ackTokenExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + ACK_TOKEN_TTL_MS);
}

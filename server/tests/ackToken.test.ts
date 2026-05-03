import { describe, it, expect } from 'vitest';
import { generateAckToken, ACK_TOKEN_TTL_MS, ackTokenExpiry, hashAckToken } from '../ackToken';

describe('generateAckToken', () => {
  it('returns a 32-character base64url string', () => {
    const t = generateAckToken();
    expect(t).toHaveLength(32);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces unique tokens across many calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(generateAckToken());
    expect(seen.size).toBe(10_000);
  });
});

describe('ACK_TOKEN_TTL_MS', () => {
  it('is 48 hours', () => {
    expect(ACK_TOKEN_TTL_MS).toBe(48 * 60 * 60 * 1000);
  });
});

describe('hashAckToken', () => {
  it('returns a 64-char hex string (sha256)', () => {
    const h = hashAckToken('any-string');
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same input → same hash', () => {
    expect(hashAckToken('abc')).toBe(hashAckToken('abc'));
  });

  it('produces different hashes for different inputs', () => {
    expect(hashAckToken('abc')).not.toBe(hashAckToken('abd'));
  });

  it('does not echo the plaintext', () => {
    const t = generateAckToken();
    expect(hashAckToken(t)).not.toBe(t);
  });
});

describe('ackTokenExpiry', () => {
  it('returns a Date exactly ACK_TOKEN_TTL_MS ms after the supplied base', () => {
    const base = new Date(0); // epoch — eliminates clock dependency
    const expiry = ackTokenExpiry(base);
    expect(expiry.getTime()).toBe(ACK_TOKEN_TTL_MS);
  });

  it('defaults to "now" when no base is provided', () => {
    const before = Date.now();
    const expiry = ackTokenExpiry();
    const after = Date.now();
    expect(expiry.getTime()).toBeGreaterThanOrEqual(before + ACK_TOKEN_TTL_MS);
    expect(expiry.getTime()).toBeLessThanOrEqual(after + ACK_TOKEN_TTL_MS);
  });
});

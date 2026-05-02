import { describe, it, expect } from 'vitest';
import { generateAckToken, ACK_TOKEN_TTL_MS } from '../ackToken';

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

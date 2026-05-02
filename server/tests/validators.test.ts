import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { isValidEmail, isValidE164, isFiniteNum, isUuid } from '../validators';

// Sync guard for the duplicated client copy. Both files re-export the same
// regex predicates; if they diverge, server validation may accept inputs the
// client rejected (or worse, vice-versa). The bodies must match byte-for-byte
// from the first `const EMAIL_RE` onwards — only the leading mirror banner
// differs.
describe('validators are mirrored client/server', () => {
  it('client and server bodies are identical below the mirror banner', () => {
    const stripBanner = (s: string) => {
      const i = s.indexOf('const EMAIL_RE');
      return i === -1 ? s : s.slice(i);
    };
    const serverSrc = fs.readFileSync(path.resolve(__dirname, '..', 'validators.ts'), 'utf8');
    const clientPath = path.resolve(__dirname, '..', '..', 'client', 'src', 'validators.ts');
    if (!fs.existsSync(clientPath)) {
      throw new Error(`client validators.ts missing at ${clientPath}`);
    }
    const clientSrc = fs.readFileSync(clientPath, 'utf8');
    expect(stripBanner(clientSrc)).toBe(stripBanner(serverSrc));
  });
});

describe('isValidEmail', () => {
  it('accepts ordinary addresses', () => {
    expect(isValidEmail('alice@example.com')).toBe(true);
    expect(isValidEmail('a.b+tag@sub.example.co.za')).toBe(true);
  });

  it('rejects obvious garbage', () => {
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(isValidEmail('@example.com')).toBe(false);
    expect(isValidEmail('alice@')).toBe(false);
    expect(isValidEmail('alice@example')).toBe(false);
    expect(isValidEmail('two@@signs.com')).toBe(false);
    expect(isValidEmail('with spaces@example.com')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isValidEmail(undefined)).toBe(false);
    expect(isValidEmail(null)).toBe(false);
    expect(isValidEmail(42)).toBe(false);
    expect(isValidEmail({ email: 'x@y.com' })).toBe(false);
  });

  it('rejects absurdly long addresses', () => {
    const local = 'a'.repeat(300);
    expect(isValidEmail(`${local}@example.com`)).toBe(false);
  });
});

describe('isValidE164', () => {
  it('accepts E.164 numbers', () => {
    expect(isValidE164('+27821234567')).toBe(true); // SA
    expect(isValidE164('+12025551234')).toBe(true); // US
    expect(isValidE164('+442071838750')).toBe(true); // UK
  });

  it('rejects national-format numbers', () => {
    expect(isValidE164('0821234567')).toBe(false); // missing +
    expect(isValidE164('27821234567')).toBe(false); // missing +
    expect(isValidE164('(202) 555-1234')).toBe(false);
  });

  it('rejects garbage', () => {
    expect(isValidE164('')).toBe(false);
    expect(isValidE164('+')).toBe(false);
    expect(isValidE164('+0123456789')).toBe(false); // leading 0 not allowed in country code
    expect(isValidE164('+abc12345')).toBe(false);
    // 16 digits exceeds the spec
    expect(isValidE164('+1234567890123456')).toBe(false);
  });
});

describe('isFiniteNum', () => {
  it('accepts ordinary finite numbers', () => {
    expect(isFiniteNum(0)).toBe(true);
    expect(isFiniteNum(-90)).toBe(true);
    expect(isFiniteNum(180)).toBe(true);
    expect(isFiniteNum(-26.2041)).toBe(true);
  });

  it('rejects NaN, Infinity, and non-numbers', () => {
    expect(isFiniteNum(Number.NaN)).toBe(false);
    expect(isFiniteNum(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isFiniteNum(Number.NEGATIVE_INFINITY)).toBe(false);
    expect(isFiniteNum('42')).toBe(false);
    expect(isFiniteNum(null)).toBe(false);
    expect(isFiniteNum(undefined)).toBe(false);
  });
});

describe('isUuid', () => {
  it('accepts canonical UUIDs', () => {
    expect(isUuid('00000000-0000-0000-0000-000000000001')).toBe(true);
    expect(isUuid('a1b2c3d4-1234-5678-9abc-def012345678')).toBe(true);
    expect(isUuid('A1B2C3D4-1234-5678-9ABC-DEF012345678')).toBe(true);
  });

  it('rejects malformed', () => {
    expect(isUuid('')).toBe(false);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('00000000-0000-0000-0000-00000000000')).toBe(false); // too short
    expect(isUuid('zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz')).toBe(false); // invalid hex
    expect(isUuid(undefined)).toBe(false);
  });
});

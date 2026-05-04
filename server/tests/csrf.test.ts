import { describe, it, expect } from 'vitest';
import { Request } from 'express';
import { verifyCsrf, CSRF_HEADER, CSRF_COOKIE, AUTH_COOKIE } from '../authCookie';

// CSRF unit tests. `verifyCsrf` is the predicate that gates every cookie-
// authenticated mutating request. The shape of "double-submit" we want:
//   * No auth cookie  → not a browser session, exempt (header-auth path).
//   * Auth cookie present, missing header → reject.
//   * Auth cookie present, header != cookie → reject.
//   * Auth cookie present, header === cookie → accept.

function mkReq(opts: { authCookie?: string; csrfCookie?: string; header?: string }): Request {
  return {
    cookies: {
      ...(opts.authCookie ? { [AUTH_COOKIE]: opts.authCookie } : {}),
      ...(opts.csrfCookie ? { [CSRF_COOKIE]: opts.csrfCookie } : {}),
    },
    headers: opts.header ? { [CSRF_HEADER]: opts.header } : {},
  } as unknown as Request;
}

describe('verifyCsrf', () => {
  it('exempts requests without an auth cookie (Bearer-auth path)', () => {
    expect(verifyCsrf(mkReq({}))).toBeNull();
    expect(verifyCsrf(mkReq({ csrfCookie: 'x' }))).toBeNull();
    // Even with a CSRF header but no auth cookie, exempt — the header path
    // doesn't carry CSRF risk.
    expect(verifyCsrf(mkReq({ header: 'x' }))).toBeNull();
  });

  it('rejects when the auth cookie is present but the CSRF cookie is missing', () => {
    expect(verifyCsrf(mkReq({ authCookie: 'jwt.value', header: 'x' }))).toBe('missing csrf cookie');
  });

  it('rejects when the auth cookie is present but the CSRF header is missing', () => {
    expect(verifyCsrf(mkReq({ authCookie: 'jwt.value', csrfCookie: 'token' }))).toBe(
      'missing csrf header',
    );
  });

  it('rejects when the cookie and header values differ', () => {
    expect(
      verifyCsrf(mkReq({ authCookie: 'jwt.value', csrfCookie: 'tokenA', header: 'tokenB' })),
    ).toBe('csrf mismatch');
  });

  it('rejects when the values match by prefix but differ in length', () => {
    expect(
      verifyCsrf(mkReq({ authCookie: 'jwt.value', csrfCookie: 'token', header: 'tokenAndMore' })),
    ).toBe('csrf mismatch');
  });

  it('accepts when cookie and header are exactly equal', () => {
    expect(
      verifyCsrf(mkReq({ authCookie: 'jwt.value', csrfCookie: 'tokenABC', header: 'tokenABC' })),
    ).toBeNull();
  });
});

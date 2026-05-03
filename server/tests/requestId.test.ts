import { describe, it, expect, vi } from 'vitest';
import { Request, Response } from 'express';
import { requestIdMiddleware, setRequestUser } from '../middleware/requestId';
import { requestContext } from '../logger';

function fakeReq(headers: Record<string, string> = {}): Request {
  return {
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

function fakeRes(): { res: Response; setHeader: ReturnType<typeof vi.fn> } {
  const setHeader = vi.fn();
  return {
    res: { setHeader } as unknown as Response,
    setHeader,
  };
}

describe('requestIdMiddleware', () => {
  it('mints a fresh ID when none is provided and exposes it on the response', () => {
    const req = fakeReq();
    const { res, setHeader } = fakeRes();
    let observed: string | undefined;
    requestIdMiddleware(req as any, res, () => {
      observed = (req as any).requestId;
      const ctx = requestContext.getStore();
      expect(ctx?.requestId).toBe(observed);
    });
    expect(observed).toMatch(/^[0-9a-f]{16}$/);
    expect(setHeader).toHaveBeenCalledWith('X-Request-Id', observed);
  });

  it('echoes a safe client-supplied X-Request-Id', () => {
    const req = fakeReq({ 'x-request-id': 'abc_123-XYZ' });
    const { res } = fakeRes();
    let observed: string | undefined;
    requestIdMiddleware(req as any, res, () => {
      observed = (req as any).requestId;
    });
    expect(observed).toBe('abc_123-XYZ');
  });

  it('rejects unsafe characters and mints a fresh ID instead', () => {
    const req = fakeReq({ 'x-request-id': 'abc; rm -rf /' });
    const { res } = fakeRes();
    let observed: string | undefined;
    requestIdMiddleware(req as any, res, () => {
      observed = (req as any).requestId;
    });
    expect(observed).toMatch(/^[0-9a-f]{16}$/);
  });

  it('rejects oversized client IDs (>64 chars) and mints fresh', () => {
    const req = fakeReq({ 'x-request-id': 'a'.repeat(65) });
    const { res } = fakeRes();
    let observed: string | undefined;
    requestIdMiddleware(req as any, res, () => {
      observed = (req as any).requestId;
    });
    expect(observed).toMatch(/^[0-9a-f]{16}$/);
  });

  it('setRequestUser populates userId on the active context', () => {
    const req = fakeReq();
    const { res } = fakeRes();
    requestIdMiddleware(req as any, res, () => {
      setRequestUser('user-42');
      const ctx = requestContext.getStore();
      expect(ctx?.userId).toBe('user-42');
    });
  });
});

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { requestContext } from '../logger';

// Per-request correlation ID middleware.
//
// Mints (or accepts) an X-Request-Id header, attaches it to req.requestId, and
// runs the rest of the middleware chain inside an AsyncLocalStorage scope so
// every log call made during the request automatically picks up `requestId`
// (and `userId`, if set after authentication). Trust client-supplied IDs only
// from a small allowlist of safe characters and a length cap — otherwise mint
// our own — so nothing weird ends up in our log indexes.

export interface RequestWithId extends Request {
  requestId?: string;
}

const SAFE_REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function newRequestId(): string {
  return crypto.randomBytes(8).toString('hex');
}

export function requestIdMiddleware(req: RequestWithId, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const requestId = incoming && SAFE_REQUEST_ID_RE.test(incoming) ? incoming : newRequestId();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  requestContext.run({ requestId }, () => next());
}

/**
 * Attach a userId to the active request context. Call this from auth
 * middleware after the JWT has been verified — every log line emitted
 * downstream will then carry `userId` alongside `requestId`.
 */
export function setRequestUser(userId: string): void {
  const store = requestContext.getStore();
  if (store) store.userId = userId;
}

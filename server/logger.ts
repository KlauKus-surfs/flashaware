import pino from 'pino';
import { AsyncLocalStorage } from 'async_hooks';

// Configure logger based on environment
const isDevelopment = process.env.NODE_ENV !== 'production';

// Per-request context. The middleware in middleware/requestId.ts populates this
// for the lifetime of the request (and any awaited work it kicks off). Any
// log call made under that scope automatically gets `requestId` injected via
// the pino `mixin` below — no need to thread it through every call site.
export interface RequestContext {
  requestId: string;
  userId?: string;
}
export const requestContext = new AsyncLocalStorage<RequestContext>();

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info'),
  base: {
    service: 'flashaware-api',
    version: process.env.npm_package_version || '1.0.0',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  mixin: () => {
    const ctx = requestContext.getStore();
    if (!ctx) return {};
    return ctx.userId
      ? { requestId: ctx.requestId, userId: ctx.userId }
      : { requestId: ctx.requestId };
  },
});

// Create child logger with request context
export function createRequestLogger(reqId: string, userId?: string) {
  return logger.child({
    requestId: reqId,
    userId: userId || 'anonymous',
  });
}

// Specialized loggers for different components
export const authLogger = logger.child({ component: 'auth' });
export const riskEngineLogger = logger.child({ component: 'risk-engine' });
export const alertLogger = logger.child({ component: 'alerts' });
export const ingestionLogger = logger.child({ component: 'ingestion' });
export const dbLogger = logger.child({ component: 'database' });

/**
 * Mask a phone number for log output. Keeps the country code prefix (everything
 * up to and including the second digit) and the trailing 4 digits, replacing
 * the middle with asterisks. Anything that doesn't look E.164-ish (or short
 * input) is fully masked. Use everywhere a phone number would otherwise hit a
 * log line — POPIA/GDPR.
 *
 *   maskPhone('+27821234567') === '+27*****4567'
 *   maskPhone('+15551234567') === '+15*****4567'
 *   maskPhone(undefined)      === 'unknown'
 *   maskPhone('1234')         === '****'
 */
export function maskPhone(p: unknown): string {
  if (p === null || p === undefined) return 'unknown';
  const s = String(p);
  if (s.length < 8) return '*'.repeat(Math.max(s.length, 4));
  // Keep + and the first two digits if present, plus the last 4. Mask the rest.
  const prefixLen = s.startsWith('+') ? 3 : 2;
  const last4 = s.slice(-4);
  const head = s.slice(0, prefixLen);
  const middleLen = Math.max(s.length - prefixLen - 4, 1);
  return `${head}${'*'.repeat(middleLen)}${last4}`;
}

export default logger;

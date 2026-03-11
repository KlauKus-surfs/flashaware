import pino from 'pino';

// Configure logger based on environment
const isDevelopment = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info'),
  base: {
    service: 'flashaware-api',
    version: process.env.npm_package_version || '1.0.0'
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// Create child logger with request context
export function createRequestLogger(reqId: string, userId?: string) {
  return logger.child({
    requestId: reqId,
    userId: userId || 'anonymous'
  });
}

// Specialized loggers for different components
export const authLogger = logger.child({ component: 'auth' });
export const riskEngineLogger = logger.child({ component: 'risk-engine' });
export const alertLogger = logger.child({ component: 'alerts' });
export const ingestionLogger = logger.child({ component: 'ingestion' });
export const dbLogger = logger.child({ component: 'database' });

export default logger;

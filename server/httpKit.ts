import { NextFunction, Request, RequestHandler, Response } from 'express';
import { logger } from './logger';

// asyncRoute(handler) — wraps an async Express route handler so any thrown
// error (or rejected promise) is logged and surfaces as a 500 instead of an
// unhandled rejection. Replaces ~40 copies of try/catch + logger.error +
// res.status(500) boilerplate that used to live inline in index.ts.
//
// Use it for any handler that does I/O. Sync handlers don't need it.
//
// Example:
//   app.get('/api/foo', asyncRoute(async (req, res) => {
//     const rows = await getFoo();
//     res.json(rows);
//   }));
export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch((err) => {
      // Don't double-respond if the handler already sent something.
      const sent = res.headersSent;
      logger.error(
        { err, route: `${req.method} ${req.path}`, userId: (req as any)?.user?.id, alreadySent: sent },
        'Unhandled error in route handler'
      );
      if (!sent) res.status(500).json({ error: 'Internal server error' });
    });
  };
}

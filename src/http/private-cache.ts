import type { NextFunction, Request, Response } from 'express';

/**
 * Financial, auth, and profile responses stay private.
 * Health is not a shared cache document.
 */
export function privateApiCache(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const path = req.path ?? '';
  if (path === '/health' || path.startsWith('/health/')) {
    res.setHeader('Cache-Control', 'no-cache');
  } else {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Pragma', 'no-cache');
  }
  next();
}

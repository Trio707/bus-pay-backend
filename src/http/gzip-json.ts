import { gzipSync } from 'node:zlib';

import type { NextFunction, Request, Response } from 'express';

const MIN_BYTES = 1024;

/**
 * Gzip JSON responses when the client accepts gzip and the body shrinks.
 * Dart's HttpClient decompresses gzip. Already-small bodies are left alone.
 */
export function gzipJsonResponses(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const accept = String(req.headers['accept-encoding'] ?? '');
  if (!/\bgzip\b/.test(accept)) {
    next();
    return;
  }

  const send = res.send.bind(res);
  res.send = ((body?: unknown) => {
    if (res.getHeader('Content-Encoding')) return send(body);
    const type = String(res.getHeader('Content-Type') ?? '');
    const payload =
      typeof body === 'string'
        ? Buffer.from(body)
        : Buffer.isBuffer(body)
          ? body
          : null;
    if (
      !payload ||
      payload.length < MIN_BYTES ||
      !type.includes('json') ||
      type.includes('gzip')
    ) {
      return send(body);
    }
    const compressed = gzipSync(payload, { level: 6 });
    if (compressed.length >= payload.length) return send(body);
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Content-Length', String(compressed.length));
    return send(compressed);
  }) as Response['send'];

  next();
}

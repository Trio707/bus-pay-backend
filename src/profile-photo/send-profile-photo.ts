import type { Response } from 'express';

export function sendProfilePhoto(
  res: Response,
  result:
    | { notModified: true; etag: string }
    | { bytes: Buffer; etag: string; updatedAt: Date },
) {
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('ETag', result.etag);
  if ('notModified' in result && result.notModified) {
    res.status(304).end();
    return;
  }
  if (!('bytes' in result)) {
    res.status(304).end();
    return;
  }
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Last-Modified', result.updatedAt.toUTCString());
  res.setHeader('Content-Length', String(result.bytes.length));
  res.status(200).end(result.bytes);
}

import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import sharp from 'sharp';

export const MAX_PROFILE_PHOTO_BYTES = 1024 * 1024;
export const PROFILE_PHOTO_EDGE = 512;

const ALLOWED = new Set(['jpeg', 'png', 'webp']);

export async function processProfilePhoto(input: Buffer): Promise<Buffer> {
  if (!Buffer.isBuffer(input) || input.length < 1) {
    throw new BadRequestException('Choose a JPEG, PNG, or WebP photo');
  }
  if (input.length > MAX_PROFILE_PHOTO_BYTES) {
    throw new PayloadTooLargeException('Profile photo must be 1 MB or smaller');
  }

  let pipeline: sharp.Sharp;
  try {
    pipeline = sharp(input, {
      failOn: 'error',
      limitInputPixels: 16_000_000,
      animated: false,
    });
    const meta = await pipeline.metadata();
    if (!meta.format || !ALLOWED.has(meta.format) || !meta.width || !meta.height) {
      throw new BadRequestException('Choose a JPEG, PNG, or WebP photo');
    }
  } catch (error) {
    if (error instanceof BadRequestException || error instanceof PayloadTooLargeException) {
      throw error;
    }
    throw new BadRequestException('Photo file is corrupt or unsupported');
  }

  const render = (quality: number) =>
    sharp(input, { failOn: 'error', animated: false })
      .rotate()
      .resize(PROFILE_PHOTO_EDGE, PROFILE_PHOTO_EDGE, {
        fit: 'cover',
        position: 'centre',
      })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();

  try {
    let output = await render(80);
    if (output.length > 250 * 1024) {
      output = await render(60);
    }
    return output;
  } catch {
    throw new BadRequestException('Photo file is corrupt or unsupported');
  }
}

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Injectable, NotFoundException } from '@nestjs/common';

import { ProfilePhotoStorage } from './profile-photo.storage';

const KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/i;

@Injectable()
export class LocalProfilePhotoStorage extends ProfilePhotoStorage {
  private readonly root = path.resolve(
    process.env.PROFILE_PHOTO_DIR?.trim() ||
      path.join(process.cwd(), 'uploads', 'profile-photos'),
  );

  async save(bytes: Buffer): Promise<string> {
    const key = `${randomUUID()}.jpg`;
    const dest = this.resolve(key);
    await mkdir(path.dirname(dest), { recursive: true });
    const temp = `${dest}.tmp`;
    await writeFile(temp, bytes);
    await rename(temp, dest);
    return key;
  }

  async read(key: string): Promise<Buffer> {
    try {
      return await readFile(this.resolve(key));
    } catch {
      throw new NotFoundException('Profile photo not found');
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  private resolve(key: string): string {
    if (!KEY_PATTERN.test(key) || key.includes('..') || key.includes('/') || key.includes('\\')) {
      throw new NotFoundException('Profile photo not found');
    }
    const full = path.resolve(this.root, key);
    const root = path.resolve(this.root);
    if (full !== path.join(root, path.basename(full))) {
      throw new NotFoundException('Profile photo not found');
    }
    return full;
  }
}

import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { UserRole, type User } from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { processProfilePhoto } from './process-profile-photo';
import { ProfilePhotoStorage } from './profile-photo.storage';

const OWN_PHOTO_URL = '/auth/profile/photo';

export type ProfilePhotoFile = {
  notModified?: false;
  bytes: Buffer;
  etag: string;
  updatedAt: Date;
};

export type ProfilePhotoNotModified = {
  notModified: true;
  etag: string;
};

@Injectable()
export class ProfilePhotoService {
  private readonly logger = new Logger(ProfilePhotoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ProfilePhotoStorage,
  ) {}

  async profile(user: User) {
    this.assertOwnerRole(user);
    return this.present(user);
  }

  async upload(user: User, bytes: Buffer) {
    this.assertOwnerRole(user);
    const processed = await processProfilePhoto(bytes);
    const previous = user.profilePhotoKey;
    const nextKey = await this.storage.save(processed);
    try {
      const updated = await this.prisma.user.update({
        where: { id: user.id },
        data: {
          profilePhotoKey: nextKey,
          profilePhotoUpdatedAt: new Date(),
        },
      });
      await this.prisma.auditLog.create({
        data: {
          actorUserId: user.id,
          action: previous ? 'PROFILE_PHOTO_REPLACED' : 'PROFILE_PHOTO_UPLOADED',
          entityType: 'User',
          entityId: user.id,
          metadata: { role: user.role },
        },
      });
      if (previous && previous !== nextKey) {
        await this.removeStored(previous);
      }
      return this.present(updated);
    } catch (error) {
      await this.removeStored(nextKey);
      throw error;
    }
  }

  async remove(user: User) {
    this.assertOwnerRole(user);
    if (!user.profilePhotoKey) {
      return { removed: false, ...this.present(user) };
    }
    const previous = user.profilePhotoKey;
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        profilePhotoKey: null,
        profilePhotoUpdatedAt: new Date(),
      },
    });
    await this.prisma.auditLog.create({
      data: {
        actorUserId: user.id,
        action: 'PROFILE_PHOTO_REMOVED',
        entityType: 'User',
        entityId: user.id,
        metadata: { role: user.role },
      },
    });
    await this.removeStored(previous);
    return { removed: true, ...this.present(updated) };
  }

  async readOwn(
    user: User,
    ifNoneMatch?: string,
  ): Promise<ProfilePhotoFile | ProfilePhotoNotModified> {
    this.assertOwnerRole(user);
    return this.readUser(user.id, ifNoneMatch);
  }

  async readForAdmin(
    userId: string,
    ifNoneMatch?: string,
  ): Promise<ProfilePhotoFile | ProfilePhotoNotModified> {
    return this.readUser(userId, ifNoneMatch);
  }

  private async readUser(
    userId: string,
    ifNoneMatch?: string,
  ): Promise<ProfilePhotoFile | ProfilePhotoNotModified> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        profilePhotoKey: true,
        profilePhotoUpdatedAt: true,
      },
    });
    if (!row?.profilePhotoKey || !row.profilePhotoUpdatedAt) {
      throw new NotFoundException('No profile photo');
    }
    const etag = this.etag(row.profilePhotoUpdatedAt);
    if (ifNoneMatch && ifNoneMatch === etag) {
      return { notModified: true, etag };
    }
    const bytes = await this.storage.read(row.profilePhotoKey);
    return { bytes, etag, updatedAt: row.profilePhotoUpdatedAt };
  }

  private present(user: {
    id: string;
    username: string;
    firstName: string;
    lastName: string;
    phone: string;
    email: string | null;
    role: UserRole;
    tillNumber: string | null;
    profilePhotoKey?: string | null;
    profilePhotoUpdatedAt?: Date | null;
  }) {
    const updatedAt = user.profilePhotoUpdatedAt ?? null;
    return {
      id: user.id,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      email: user.email,
      role: user.role,
      tillNumber: user.tillNumber,
      profilePhotoUrl: user.profilePhotoKey ? OWN_PHOTO_URL : null,
      profilePhotoUpdatedAt: updatedAt ? updatedAt.toISOString() : null,
    };
  }

  private assertOwnerRole(user: User) {
    if (user.role !== UserRole.CONDUCTOR && user.role !== UserRole.AGENT) {
      throw new ForbiddenException(
        'Only conductors and wakala can change a profile photo',
      );
    }
  }

  private etag(updatedAt: Date) {
    return `"${updatedAt.getTime()}"`;
  }

  private async removeStored(key: string) {
    try {
      await this.storage.delete(key);
    } catch (error) {
      this.logger.warn(
        `Profile photo cleanup failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }
}

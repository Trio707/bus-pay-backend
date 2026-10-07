import { GUARDS_METADATA } from '@nestjs/common/constants';
import {
  BadRequestException,
  ForbiddenException,
  PayloadTooLargeException,
} from '@nestjs/common';
import sharp from 'sharp';
import { UserRole } from '../generated/prisma';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ROLES_KEY } from '../auth/roles.decorator';
import { MAX_PROFILE_PHOTO_BYTES } from './process-profile-photo';
import { ProfilePhotoController } from './profile-photo.controller';
import { ProfilePhotoService } from './profile-photo.service';
import { ProfilePhotoStorage } from './profile-photo.storage';

function user(role: UserRole, extra: Record<string, unknown> = {}) {
  return {
    id: role === UserRole.AGENT ? 'agent-1' : 'cond-1',
    username: 'Bp-c100000bus',
    firstName: 'Juma',
    lastName: 'Omari',
    phone: '+255712345678',
    email: null,
    role,
    tillNumber: null,
    profilePhotoKey: null,
    profilePhotoUpdatedAt: null,
    ...extra,
  } as never;
}

describe('profile photos', () => {
  let jpeg: Buffer;
  const storage: jest.Mocked<ProfilePhotoStorage> = {
    save: jest.fn(),
    read: jest.fn(),
    delete: jest.fn(),
  };
  const prisma = {
    user: { update: jest.fn(), findUnique: jest.fn() },
    auditLog: { create: jest.fn() },
    wallet: { update: jest.fn() },
    wakalaFloat: { update: jest.fn() },
    paymentTransaction: { create: jest.fn() },
  };

  beforeAll(async () => {
    jpeg = await sharp({
      create: { width: 8, height: 4, channels: 3, background: '#336699' },
    })
      .jpeg()
      .toBuffer();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    storage.save.mockResolvedValue('11111111-1111-1111-1111-111111111111.jpg');
    storage.delete.mockResolvedValue(undefined);
    prisma.auditLog.create.mockResolvedValue({});
    prisma.user.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...user(UserRole.CONDUCTOR),
      ...data,
    }));
  });

  function service() {
    return new ProfilePhotoService(prisma as never, storage);
  }

  it('lets a conductor and a wakala upload a photo', async () => {
    const conductor = await service().upload(user(UserRole.CONDUCTOR), jpeg);
    const wakala = await service().upload(user(UserRole.AGENT), jpeg);
    expect(conductor.profilePhotoUrl).toBe('/auth/profile/photo');
    expect(wakala.profilePhotoUrl).toBe('/auth/profile/photo');
    expect(conductor.profilePhotoUpdatedAt).toEqual(expect.any(String));
    expect(JSON.stringify(conductor)).not.toMatch(/base64|[A-Za-z0-9+/]{80,}/);
    expect(JSON.stringify(conductor)).not.toContain('profilePhotoKey');
  });

  it('rejects an unsupported role and never accepts another user id', async () => {
    await expect(service().upload(user(UserRole.ADMIN), jpeg)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    const actor = user(UserRole.CONDUCTOR);
    await service().upload(actor, jpeg);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cond-1' } }),
    );
    expect(JSON.stringify(prisma.user.update.mock.calls)).not.toContain('someone-else');
  });

  it('rejects oversized, unsupported, and corrupt files', async () => {
    await expect(
      service().upload(user(UserRole.CONDUCTOR), Buffer.alloc(MAX_PROFILE_PHOTO_BYTES + 1)),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    await expect(
      service().upload(user(UserRole.CONDUCTOR), Buffer.from('not-an-image')),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service().upload(user(UserRole.CONDUCTOR), Buffer.from([0xff, 0xd8, 0xff, 0x00, 1, 2, 3])),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps the new photo and removes the old one only after the update succeeds', async () => {
    const existing = user(UserRole.CONDUCTOR, { profilePhotoKey: 'old-photo.jpg' });
    await service().upload(existing, jpeg);
    expect(storage.delete).toHaveBeenCalledWith('old-photo.jpg');
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'PROFILE_PHOTO_REPLACED' }),
      }),
    );

    storage.delete.mockClear();
    prisma.user.update.mockRejectedValueOnce(new Error('db down'));
    await expect(service().upload(existing, jpeg)).rejects.toThrow('db down');
    expect(storage.delete).toHaveBeenCalledWith(
      '11111111-1111-1111-1111-111111111111.jpg',
    );
    expect(storage.delete).not.toHaveBeenCalledWith('old-photo.jpg');
  });

  it('removes a photo and treats a missing photo as a safe no-op', async () => {
    const existing = user(UserRole.AGENT, {
      profilePhotoKey: 'old-photo.jpg',
      profilePhotoUpdatedAt: new Date(),
    });
    const removed = await service().remove(existing);
    expect(removed.removed).toBe(true);
    expect(removed.profilePhotoUrl).toBeNull();
    expect(storage.delete).toHaveBeenCalledWith('old-photo.jpg');
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'PROFILE_PHOTO_REMOVED' }),
      }),
    );

    prisma.user.update.mockClear();
    const empty = await service().remove(user(UserRole.CONDUCTOR));
    expect(empty.removed).toBe(false);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('does not touch wallets, float, or payment rows', async () => {
    await service().upload(user(UserRole.AGENT), jpeg);
    expect(prisma.wallet.update).not.toHaveBeenCalled();
    expect(prisma.wakalaFloat.update).not.toHaveBeenCalled();
    expect(prisma.paymentTransaction.create).not.toHaveBeenCalled();
  });

  it('requires authentication and limits the route to conductor and wakala', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, ProfilePhotoController);
    const roles = Reflect.getMetadata(ROLES_KEY, ProfilePhotoController);
    expect(guards).toEqual(expect.arrayContaining([JwtAuthGuard]));
    expect(roles).toEqual([UserRole.CONDUCTOR, UserRole.AGENT]);
    expect(roles).not.toContain(UserRole.ADMIN);
  });
});

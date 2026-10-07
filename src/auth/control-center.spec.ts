import { ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';

import { UserRole, UserStatus, type User } from '../generated/prisma';
import { AdminService } from '../admin/admin.service';
import { AuthService } from './auth.service';
import { AuthorizationService } from './authorization.service';
import { PermissionGuard } from './permission.guard';
import { ALL_PERMISSION_CODES } from './permissions';

function actor(role: UserRole, id = 'user-1'): User {
  return {
    id,
    role,
    status: UserStatus.ACTIVE,
    username: 'name',
    firstName: 'Amina',
    lastName: 'Juma',
    phone: '+255700000001',
    email: 'person@example.com',
    passwordHash: 'hash',
  } as User;
}

function httpContext(user: User | undefined) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => 'handler',
    getClass: () => 'class',
  } as never;
}

describe('BusPay control center authorization', () => {
  it('gives ADMIN every permission without permission rows', async () => {
    const findUnique = jest.fn();
    const authz = new AuthorizationService({
      userPermission: { findUnique, findMany: jest.fn() },
    } as never);
    expect(authz.isAdmin(actor(UserRole.ADMIN))).toBe(true);
    expect(
      await authz.hasPermission(actor(UserRole.ADMIN), 'FINANCIAL_COMPANY_VIEW'),
    ).toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
    expect(await authz.permissionCodes(actor(UserRole.ADMIN))).toEqual(
      ALL_PERMISSION_CODES,
    );
  });

  it('denies AGENT and CONDUCTOR admin permissions', async () => {
    const findUnique = jest.fn();
    const authz = new AuthorizationService({
      userPermission: { findUnique },
    } as never);
    expect(
      await authz.hasPermission(actor(UserRole.AGENT), 'WAKALA_VIEW'),
    ).toBe(false);
    expect(
      await authz.hasPermission(actor(UserRole.CONDUCTOR), 'WAKALA_VIEW'),
    ).toBe(false);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('allows a MASTER_AGENT only the permissions stored for that user', async () => {
    const findUnique = jest.fn().mockImplementation(
      async ({ where }: { where: { userId_permissionCode: { permissionCode: string } } }) =>
        where.userId_permissionCode.permissionCode === 'WAKALA_VIEW'
          ? { userId: 'master-1' }
          : null,
    );
    const authz = new AuthorizationService({
      userPermission: { findUnique },
    } as never);
    const master = actor(UserRole.MASTER_AGENT, 'master-1');
    await expect(authz.requireUserList(master, UserRole.AGENT)).resolves.toBeUndefined();
    await expect(
      authz.requirePermission(master, 'WAKALA_CREATE'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      authz.requirePermission(master, 'FINANCIAL_COMPANY_VIEW'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses role escalation by a master wakala', () => {
    const authz = new AuthorizationService({} as never);
    const master = actor(UserRole.MASTER_AGENT, 'master-1');
    expect(() => authz.assertRoleChange(master, 'other', UserRole.ADMIN)).toThrow(
      ForbiddenException,
    );
    expect(() =>
      authz.assertRoleChange(master, master.id, UserRole.AGENT),
    ).toThrow(ForbiddenException);
    expect(() =>
      authz.assertCanManageMasterPermissions(master, 'other'),
    ).toThrow(ForbiddenException);
    expect(() =>
      authz.assertCanManageMasterPermissions(master, master.id),
    ).toThrow(ForbiddenException);
    expect(() => authz.assertAssignable(['PERMISSION_MANAGE'])).toThrow(
      ForbiddenException,
    );
  });

  it('returns 403 from the permission guard when the permission is missing', async () => {
    const reflector = {
      getAllAndOverride: jest
        .fn()
        .mockReturnValueOnce(['FINANCIAL_COMPANY_VIEW'])
        .mockReturnValueOnce(undefined),
    };
    const authorization = {
      hasPermission: jest.fn().mockResolvedValue(false),
      requireAny: jest.fn(),
    };
    const guard = new PermissionGuard(reflector as never, authorization as never);
    await expect(
      guard.canActivate(httpContext(actor(UserRole.MASTER_AGENT))),
    ).rejects.toBeInstanceOf(ForbiddenException);

    reflector.getAllAndOverride.mockReturnValue(undefined);
    await expect(
      guard.canActivate(httpContext(actor(UserRole.MASTER_AGENT))),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await expect(
      guard.canActivate(httpContext(actor(UserRole.ADMIN))),
    ).resolves.toBe(true);
  });

  it('logs ADMIN and MASTER_AGENT in through the same admin login', async () => {
    const passwordHash = await bcrypt.hash('secret', 4);
    const base = {
      username: 'Bp-x100000admin',
      firstName: 'amina',
      lastName: 'juma',
      phone: '+255700000099',
      email: 'owner@example.com',
      passwordHash,
      status: UserStatus.ACTIVE,
      tillNumber: null,
      mustChangePassword: false,
      profilePhotoKey: null,
      profilePhotoUpdatedAt: null,
      sessionVersion: 0,
      failedLoginAttempts: 0,
      lockedUntil: null,
    };
    const update = jest.fn().mockResolvedValue({ sessionVersion: 1 });
    const findMany = jest.fn().mockResolvedValue([
      { permissionCode: 'WAKALA_VIEW' },
      { permissionCode: 'WAKALA_CREATE' },
    ]);
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce({ ...base, id: 'admin-1', role: UserRole.ADMIN })
      .mockResolvedValueOnce({
        ...base,
        id: 'master-1',
        role: UserRole.MASTER_AGENT,
        username: 'Bp-m100000lead',
        credentialEmailSentAt: new Date(),
      });
    const service = new AuthService(
      { user: { findFirst, update }, userPermission: { findMany } } as never,
      { signAsync: jest.fn().mockResolvedValue('token') } as unknown as JwtService,
      { enqueue: jest.fn() } as never,
      { flush: jest.fn() } as never,
    );

    const admin = await service.loginAdmin({
      email: 'owner@example.com',
      password: 'secret',
    });
    expect(admin.user.role).toBe('admin');
    expect(admin.user.permissions).toEqual(ALL_PERMISSION_CODES);

    const master = await service.loginAdmin({
      email: 'owner@example.com',
      password: 'secret',
    });
    expect(master.user.role).toBe('master_agent');
    expect(master.user.permissions).toEqual(['WAKALA_VIEW', 'WAKALA_CREATE']);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          role: { in: [UserRole.ADMIN, UserRole.MASTER_AGENT] },
        }),
      }),
    );
  });

  it('creates a wakala as AGENT and refuses other roles', async () => {
    const create = jest.fn().mockImplementation(async ({ data }) => ({
      id: 'wakala-1',
      ...data,
    }));
    const service = new AuthService(
      {
        user: {
          findFirst: jest.fn().mockResolvedValue(null),
          create,
        },
        auditLog: { create: jest.fn().mockResolvedValue({}) },
      } as never,
      { signAsync: jest.fn() } as unknown as JwtService,
      { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
      { flush: jest.fn() } as never,
    );
    const master = actor(UserRole.MASTER_AGENT, 'master-1');
    await expect(
      service.createWakala(
        {
          firstName: 'Neema',
          lastName: 'Omari',
          email: 'neema@example.com',
          phone: '0712345678',
          nida: '19900101123456789012',
        },
        actor(UserRole.CONDUCTOR),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const created = await service.createWakala(
      {
        firstName: 'Neema',
        lastName: 'Omari',
        email: 'neema@example.com',
        phone: '0712345678',
        nida: '19900101123456789012',
      },
      master,
    );
    expect(created.role).toBe('agent');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: UserRole.AGENT }),
      }),
    );
  });
});

describe('Master Wakala administration', () => {
  function setup() {
    const prisma = {
      user: {
        findUnique: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      userPermission: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(async (run: (tx: unknown) => Promise<unknown>) => run(prisma)),
    };
    const service = new AdminService(
      prisma as never,
      { enqueue: jest.fn() } as never,
      { getBalance: jest.fn(), record: jest.fn() } as never,
    );
    return { service, prisma };
  }

  const admin = actor(UserRole.ADMIN, 'admin-1');
  const master = actor(UserRole.MASTER_AGENT, 'master-1');

  it('lets only an admin assign and revoke permissions, and audits both', async () => {
    const { service, prisma } = setup();
    prisma.user.findUnique.mockResolvedValue({
      id: 'master-1',
      role: UserRole.MASTER_AGENT,
    });
    prisma.userPermission.findMany.mockResolvedValue([
      { permissionCode: 'WAKALA_VIEW' },
      { permissionCode: 'DASHBOARD_VIEW' },
    ]);

    await expect(
      service.setMasterPermissions(master, 'master-1', ['WAKALA_CREATE']),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const saved = await service.setMasterPermissions(admin, 'master-1', [
      'WAKALA_VIEW',
      'WAKALA_CREATE',
    ]);
    expect(saved.permissions).toEqual(['WAKALA_VIEW', 'WAKALA_CREATE']);
    const actions = prisma.auditLog.create.mock.calls.map(
      (call) => call[0].data.action,
    );
    expect(actions).toContain('MASTER_AGENT_PERMISSION_GRANTED');
    expect(actions).toContain('MASTER_AGENT_PERMISSION_REVOKED');
  });

  it('audits block and unblock and refuses a master wakala', async () => {
    const { service, prisma } = setup();
    prisma.user.findUnique.mockResolvedValue({
      id: 'master-2',
      role: UserRole.MASTER_AGENT,
      status: UserStatus.ACTIVE,
    });
    prisma.user.update.mockImplementation(async ({ data }) => ({
      id: 'master-2',
      username: 'Bp-m100000lead',
      firstName: 'Amina',
      lastName: 'Juma',
      phone: '+255700000001',
      email: 'person@example.com',
      status: data.status,
      createdAt: new Date(),
      permissions: [],
    }));

    await expect(service.blockMasterWakala(master, 'master-2')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await service.blockMasterWakala(admin, 'master-2');
    await service.unblockMasterWakala(admin, 'master-2');
    const actions = prisma.auditLog.create.mock.calls.map(
      (call) => call[0].data.action,
    );
    expect(actions).toEqual([
      'MASTER_AGENT_BLOCKED',
      'MASTER_AGENT_UNBLOCKED',
    ]);
  });

  it('refuses a master changing their own role through profile update', async () => {
    const { service } = setup();
    await expect(
      service.updateMasterWakala(admin, 'master-1', {
        firstName: 'Amina',
        role: UserRole.ADMIN,
      } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

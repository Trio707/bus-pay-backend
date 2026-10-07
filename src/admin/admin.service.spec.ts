import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { UserRole, UserStatus } from '../generated/prisma';
import { AdminService } from './admin.service';

describe('AdminService', () => {
  const actor = {
    id: 'admin-1',
    role: UserRole.ADMIN,
  } as never;

  let prisma: {
    user: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    terminal: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
    };
    auditLog: { create: jest.Mock; findMany: jest.Mock; count: jest.Mock };
    card: { count: jest.Mock };
    wallet: { count: jest.Mock };
    paymentTransaction: { aggregate: jest.Mock };
    topUp: { aggregate: jest.Mock };
  };
  let service: AdminService;

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      terminal: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      card: { count: jest.fn() },
      wallet: { count: jest.fn() },
      paymentTransaction: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 }, _count: 0 }),
      },
      topUp: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 }, _count: 0 }),
      },
    };
    service = new AdminService(
      prisma as never,
      { enqueue: jest.fn() } as never,
      { getBalance: jest.fn(), record: jest.fn() } as never,
    );
  });

  it('lists users with pagination', async () => {
    prisma.user.count.mockResolvedValue(1);
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'u1',
        username: 'Bp-a111111agent',
        firstName: 'A',
        lastName: 'B',
        phone: '+255700000001',
        email: 'a@b.com',
        nida: '1',
        tillNumber: '0000-0001',
        role: UserRole.AGENT,
        status: UserStatus.ACTIVE,
        failedLoginAttempts: 0,
        lockedUntil: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const result = await service.listUsers({ page: 1, limit: 50 });
    expect(result.total).toBe(1);
    expect(result.users[0].role).toBe('agent');
  });

  it('updates user status and writes audit', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      role: UserRole.AGENT,
      status: UserStatus.ACTIVE,
    });
    prisma.user.update.mockResolvedValue({
      id: 'u1',
      username: 'Bp-a111111agent',
      role: UserRole.AGENT,
      status: UserStatus.SUSPENDED,
    });

    const result = await service.updateUserStatus(actor, 'u1', {
      status: UserStatus.SUSPENDED,
    });

    expect(result.status).toBe(UserStatus.SUSPENDED);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'USER_STATUS_UPDATE',
          entityId: 'u1',
        }),
      }),
    );
  });

  it('rejects suspending an admin', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'admin-2',
      role: UserRole.ADMIN,
      status: UserStatus.ACTIVE,
    });

    await expect(
      service.updateUserStatus(actor, 'admin-2', {
        status: UserStatus.SUSPENDED,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('assigns terminal to active conductor', async () => {
    prisma.terminal.findUnique.mockResolvedValue({
      id: 't1',
      ownerUserId: null,
    });
    prisma.user.findUnique.mockResolvedValue({
      id: 'c1',
      role: UserRole.CONDUCTOR,
      status: UserStatus.ACTIVE,
    });
    prisma.terminal.update.mockResolvedValue({
      id: 't1',
      terminalCode: 'T-001',
      merchant: { merchantCode: 'M1', name: 'Bus Co' },
      owner: {
        id: 'c1',
        username: 'Bp-c123456bus',
        firstName: 'C',
        lastName: 'D',
      },
    });

    const result = await service.assignTerminal(actor, 't1', {
      conductorUserId: 'c1',
    });

    expect(result.conductor?.id).toBe('c1');
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'TERMINAL_ASSIGN' }),
      }),
    );
  });

  it('rejects assign when terminal missing', async () => {
    prisma.terminal.findUnique.mockResolvedValue(null);
    await expect(
      service.assignTerminal(actor, 'missing', { conductorUserId: 'c1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

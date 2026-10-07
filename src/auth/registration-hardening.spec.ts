import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common/interfaces';
import * as bcrypt from 'bcrypt';
import {
  UserRole,
  UserStatus,
  WakalaFloatTransactionType,
  WithdrawalStatus,
} from '../generated/prisma';
import { AdminService } from '../admin/admin.service';
import { idleBooks } from '../financial/idle-books';
import { PlatformService } from '../platform/platform.service';
import { AuthService } from './auth.service';
import { MustChangePasswordGuard } from './must-change-password.guard';
import { assertNidaAvailable, MAX_CONDUCTORS_PER_NIDA } from './nida-policy';
import {
  assertStrongPassword,
  generateTemporaryPassword,
} from './password-policy';

const NIDA = '19900101123451234512';
const PHONE = '+255712345678';
const WEAK =
  'Password is too weak. Use at least 12 characters including uppercase, lowercase, number, and special character.';

function wakalaDto(overrides: Record<string, string> = {}) {
  return {
    firstName: 'Asha',
    lastName: 'Juma',
    email: 'asha@buspay.co.tz',
    phone: PHONE,
    nida: NIDA,
    ...overrides,
  };
}

function authHarness() {
  const users: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const sms: Array<{ phone: string; type: string; message: string }> = [];
  const prisma = {
    user: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, any> }) => {
        return (
          users.find((user) => {
            if (where.phone?.in) return where.phone.in.includes(user.phone);
            if (where.email) {
              return (
                user.role === where.role &&
                String(user.email).toLowerCase() ===
                  String(where.email.equals).toLowerCase()
              );
            }
            if (where.nida && where.role?.in) {
              return (
                user.nida === where.nida && where.role.in.includes(user.role)
              );
            }
            if (where.username) return false;
            return false;
          }) ?? null
        );
      }),
      count: jest.fn(
        async ({ where }: { where: { nida: string; role: UserRole } }) =>
          users.filter(
            (user) => user.nida === where.nida && user.role === where.role,
          ).length,
      ),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const user = { id: `user-${users.length + 1}`, sessionVersion: 0, ...data };
        users.push(user);
        return user;
      }),
      update: jest.fn(async ({ data, select }: { data: Record<string, any>; select?: { sessionVersion?: boolean } }) => {
        if (select?.sessionVersion) return { sessionVersion: 2 };
        return data;
      }),
      findUnique: jest.fn(),
    },
    auditLog: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return data;
      }),
    },
    merchant: { findUnique: jest.fn().mockResolvedValue(null) },
    terminal: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const enqueue = jest.fn(async (phone: string, type: string, message: string) => {
    sms.push({ phone, type, message });
    return { id: 'sms-1' };
  });
  const service = new AuthService(
    prisma as never,
    { signAsync: jest.fn().mockResolvedValue('jwt-token') } as never,
    { enqueue } as never,
    { flush: jest.fn() } as never,
  );
  return { service, prisma, users, audits, sms, enqueue };
}

describe('wakala password and email', () => {
  it('requires a real email and does not invent a gmail address', async () => {
    const { service, users } = authHarness();
    await expect(
      service.createWakala(wakalaDto({ email: 'not-an-email' }) as never, {
        id: 'admin-1',
      } as never),
    ).rejects.toThrow('Use a valid email');

    const created = await service.createWakala(
      wakalaDto({ email: '  Owner@BusPay.co.tz  ' }) as never,
      { id: 'admin-1' } as never,
    );
    expect(created.email).toBe('owner@buspay.co.tz');
    expect(String(users[0].email)).not.toMatch(/^[a-z0-9]{8,}@gmail\.com$/);
    expect(JSON.stringify(created)).not.toContain('gmail.com');
  });

  it('rejects a duplicate wakala email ignoring case and spaces', async () => {
    const { service } = authHarness();
    const actor = { id: 'admin-1' } as never;
    await service.createWakala(wakalaDto() as never, actor);
    await expect(
      service.createWakala(
        wakalaDto({
          email: '  ASHA@buspay.co.tz ',
          phone: '+255713000099',
          nida: '20000101123451234599',
        }) as never,
        actor,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('stores only a password hash and does not put the password in SMS', async () => {
    const { service, users, audits, sms } = authHarness();
    const created = await service.createWakala(wakalaDto() as never, {
      id: 'admin-1',
    } as never);
    const stored = String(users[0].passwordHash);
    const message = sms[0].message;

    expect(stored.startsWith('$2')).toBe(true);
    expect(message).not.toContain(stored);
    expect(message.toLowerCase()).not.toContain('password');
    expect(message.startsWith('BusPay')).toBe(false);
    expect(JSON.stringify(created)).not.toContain(stored);
    expect(JSON.stringify(audits)).not.toContain(stored);
    expect(sms).toEqual([
      expect.objectContaining({
        phone: PHONE,
        type: 'WAKALA_ACCOUNT_CREDENTIALS',
      }),
    ]);
    expect(message).toContain(`Jina la mtumiaji ni ${created.username}`);
    expect(users[0].mustChangePassword).toBe(true);
    expect(
      audits.some(
        (row) =>
          row.action === 'USER_CREATE' &&
          JSON.stringify(row.metadata).includes('mustChangePassword'),
      ),
    ).toBe(true);
    expect(audits.some((row) => row.action === 'PASSWORD_ISSUED')).toBe(true);
  });

  it('keeps credential delivery from rolling back account creation', async () => {
    const { service, users, enqueue } = authHarness();
    enqueue.mockRejectedValueOnce(new Error('sms down'));
    const created = await service.createWakala(wakalaDto() as never, {
      id: 'admin-1',
    } as never);
    expect(created.username).toMatch(/agent/i);
    expect(users).toHaveLength(1);
  });
});

describe('password policy and first login', () => {
  const identity = {
    phone: PHONE,
    nida: NIDA,
    username: 'Bp-a123456agent',
  };

  it('accepts a strong password and rejects weak shapes', () => {
    expect(() =>
      assertStrongPassword('Correct-Horse-9', identity),
    ).not.toThrow();
    expect(() => assertStrongPassword('Short1!a', identity)).toThrow(WEAK);
    expect(() => assertStrongPassword('alllowercase1!', identity)).toThrow(WEAK);
    expect(() => assertStrongPassword('ALLUPPERCASE1!', identity)).toThrow(WEAK);
    expect(() => assertStrongPassword('NoDigitsHere!!', identity)).toThrow(WEAK);
    expect(() => assertStrongPassword('NoSpecialChar1', identity)).toThrow(WEAK);
    expect(() => assertStrongPassword('Password123!', identity)).toThrow(WEAK);
    expect(() => assertStrongPassword('Aa712345678!xx', identity)).toThrow(
      'phone, NIDA, or username',
    );
    expect(() => assertStrongPassword('Aa19900101!xyz', identity)).toThrow(
      'phone, NIDA, or username',
    );
    expect(() =>
      assertStrongPassword('Xxbp-a123456agent1!', identity),
    ).toThrow('phone, NIDA, or username');
  });

  it('clears mustChangePassword after a strong change and blocks the dashboard before that', async () => {
    const { service, prisma, audits } = authHarness();
    const current = 'OldPassword1!x';
    const user = {
      id: 'agent-1',
      role: UserRole.AGENT,
      passwordHash: await bcrypt.hash(current, 4),
      phone: PHONE,
      nida: NIDA,
      username: 'Bp-a123456agent',
      failedLoginAttempts: 0,
      lockedUntil: null,
      mustChangePassword: true,
      status: UserStatus.ACTIVE,
    };
    await expect(
      service.changeAgentPassword(user as never, {
        currentPassword: current,
        password: 'short',
        confirmPassword: 'short',
      }),
    ).rejects.toThrow(WEAK);

    await service.changeAgentPassword(user as never, {
      currentPassword: current,
      password: 'NewPassword1!x',
      confirmPassword: 'NewPassword1!x',
    });
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ mustChangePassword: false }),
      }),
    );
    expect(JSON.stringify(audits)).not.toContain('NewPassword1!x');
    expect(audits.some((row) => row.action === 'PASSWORD_CHANGED')).toBe(true);

    const guard = new MustChangePasswordGuard();
    const context = (account: object) =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ user: account }) }),
      }) as ExecutionContext;
    expect(() =>
      guard.canActivate(
        context({ role: UserRole.AGENT, mustChangePassword: true }),
      ),
    ).toThrow(ForbiddenException);
    expect(
      guard.canActivate(
        context({ role: UserRole.AGENT, mustChangePassword: false }),
      ),
    ).toBe(true);
    expect(
      guard.canActivate(context({ role: UserRole.CONDUCTOR, mustChangePassword: false })),
    ).toBe(true);
    expect(guard.canActivate(context({ role: UserRole.ADMIN }))).toBe(true);
  });

  it('still signs in an existing admin and conductor', async () => {
    const { service, prisma } = authHarness();
    const pin = '1234';
    const password = 'AdminPass1!xyz';
    prisma.user.findFirst.mockImplementation(async ({ where }: { where: Record<string, any> }) => {
      if (where.role === UserRole.CONDUCTOR) {
        return {
          id: 'cond-1',
          username: 'Bp-c123456bus',
          role: UserRole.CONDUCTOR,
          status: UserStatus.ACTIVE,
          passwordHash: await bcrypt.hash(pin, 4),
          phone: PHONE,
          email: null,
          firstName: 'Juma',
          lastName: 'Omari',
          tillNumber: null,
          mustChangePassword: false,
          failedLoginAttempts: 0,
          lockedUntil: null,
        };
      }
      return {
        id: 'admin-1',
        username: 'Bp-x123456admin',
        role: UserRole.ADMIN,
        status: UserStatus.ACTIVE,
        passwordHash: await bcrypt.hash(password, 4),
        phone: '+255714000001',
        email: 'admin@buspay.co.tz',
        firstName: 'Admin',
        lastName: 'User',
        tillNumber: null,
        mustChangePassword: false,
        failedLoginAttempts: 0,
        lockedUntil: null,
      };
    });

    const conductor = await service.login({ phone: '0712345678', pin } as never);
    const admin = await service.loginAdmin({
      email: 'admin@buspay.co.tz',
      password,
    } as never);
    expect(conductor.accessToken).toBe('jwt-token');
    expect(conductor.user.mustChangePassword).toBe(false);
    expect(admin.accessToken).toBe('jwt-token');
    expect(admin.user.role).toBe('admin');
  });
});

describe('conductor NIDA limit', () => {
  it('allows five conductor accounts and rejects the sixth', async () => {
    const conductors = Array.from({ length: 5 }, (_, index) => ({
      nida: NIDA,
      role: UserRole.CONDUCTOR,
      id: `c-${index}`,
    }));
    const prisma = {
      user: {
        count: jest.fn(async () => conductors.length),
        findFirst: jest.fn(async ({ where }: { where: { role?: { in?: UserRole[] } } }) => {
          if (where.role?.in?.includes(UserRole.ADMIN)) {
            return { id: 'admin-nida' };
          }
          return null;
        }),
      },
    };
    await expect(
      assertNidaAvailable(prisma as never, NIDA, UserRole.CONDUCTOR),
    ).rejects.toThrow('maximum of 5');
    expect(MAX_CONDUCTORS_PER_NIDA).toBe(5);

    prisma.user.count.mockResolvedValue(4);
    await expect(
      assertNidaAvailable(prisma as never, NIDA, UserRole.CONDUCTOR),
    ).resolves.toBeUndefined();
    for (const count of [0, 1, 2, 3, 4]) {
      prisma.user.count.mockResolvedValue(count);
      await expect(
        assertNidaAvailable(prisma as never, NIDA, UserRole.CONDUCTOR),
      ).resolves.toBeUndefined();
    }

    await expect(
      assertNidaAvailable(prisma as never, NIDA, UserRole.AGENT),
    ).rejects.toThrow('NIDA is already registered');
    prisma.user.findFirst.mockResolvedValue(null);
    await expect(
      assertNidaAvailable(prisma as never, NIDA, UserRole.ADMIN),
    ).resolves.toBeUndefined();
  });
});

describe('wakala float funding SMS', () => {
  const admin = { id: 'admin-1', role: UserRole.ADMIN } as never;
  const agent = {
    id: 'agent-1',
    role: UserRole.AGENT,
    firstName: 'Asha',
    lastName: 'Juma',
    tillNumber: '1111-2222',
    phone: PHONE,
  };

  function setup(recordResult: Record<string, unknown> | Error) {
    const record = jest.fn(async () => {
      if (recordResult instanceof Error) throw recordResult;
      return recordResult;
    });
    const enqueue = jest.fn().mockResolvedValue({ id: 'sms-1' });
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(agent) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ auditLog: prisma.auditLog }),
    };
    const service = new AdminService(
      prisma as never,
      { enqueue } as never,
      {
        record,
        nextFundingReference: jest.fn().mockResolvedValue('FF-ABC123'),
      } as never,
    );
    return { service, record, enqueue, prisma };
  }

  it('creates a funding row and a wakala SMS with amount and reference', async () => {
    const { service, record, enqueue, prisma } = setup({
      reference: 'FF-ABC123',
      balanceBefore: 500_000,
      balanceAfter: 1_000_000,
      alreadyPosted: false,
    });
    const result = await service.fundWakalaFloat(admin, 'agent-1', {
      amount: 500_000,
    });
    expect(record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: WakalaFloatTransactionType.FLOAT_FUNDING,
        amount: 500_000,
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalled();
    expect(result.balanceAfter).toBe(1_000_000);
    expect(enqueue).toHaveBeenCalledWith(
      PHONE,
      'WAKALA_FLOAT_FUNDING',
      expect.stringContaining('TZS 500,000'),
    );
    expect(enqueue.mock.calls[0][2]).toContain('TZS 1,000,000');
    expect(enqueue.mock.calls[0][2]).toContain('FF-ABC123');
  });

  it('does not send a success SMS when funding fails or is replayed', async () => {
    const failed = setup(new Error('database down'));
    await expect(
      failed.service.fundWakalaFloat(admin, 'agent-1', { amount: 500_000 }),
    ).rejects.toThrow('database down');
    expect(failed.enqueue).not.toHaveBeenCalled();

    const replay = setup({
      reference: 'FF-ABC123',
      balanceBefore: 1_000_000,
      balanceAfter: 1_000_000,
      alreadyPosted: true,
    });
    await replay.service.fundWakalaFloat(admin, 'agent-1', {
      amount: 500_000,
      reference: 'FF-ABC123',
    });
    expect(replay.enqueue).not.toHaveBeenCalled();
  });

  it('keeps the funding when SMS enqueue fails', async () => {
    const { service, enqueue } = setup({
      reference: 'FF-ABC123',
      balanceBefore: 0,
      balanceAfter: 500_000,
      alreadyPosted: false,
    });
    enqueue.mockRejectedValue(new Error('provider down'));
    const result = await service.fundWakalaFloat(admin, 'agent-1', {
      amount: 500_000,
    });
    expect(result.balanceAfter).toBe(500_000);
    expect(result.reference).toBe('FF-ABC123');
  });
});

describe('conductor withdrawal success SMS', () => {
  function platform() {
    const enqueue = jest.fn().mockResolvedValue({});
    const record = jest.fn().mockResolvedValue({
      reference: 'WD-0001',
      balanceAfter: 600_000,
      alreadyPosted: false,
    });
    const prisma = {
      user: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'agent-1',
            role: UserRole.AGENT,
            status: UserStatus.ACTIVE,
            firstName: 'Asha',
            lastName: 'Juma',
            phone: PHONE,
            tillNumber: '1111-2222',
          },
        ]),
      },
      terminal: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'term-1',
          terminalCode: 'DLD-C0001',
          merchantId: 'm-1',
        }),
      },
      paymentTransaction: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 200_000 } }),
      },
      withdrawal: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
      },
      conductorPayout: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          $queryRaw: jest.fn().mockResolvedValue([]),
          paymentTransaction: {
            aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 200_000 } }),
          },
          conductorPayout: {
            aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
          },
          withdrawal: {
            aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
            create: jest.fn().mockResolvedValue({
              id: 'wd-1',
              reference: 'WD-0001',
            }),
            findUnique: jest.fn().mockResolvedValue(null),
          },
          auditLog: { create: jest.fn().mockResolvedValue({}) },
        }),
    };
    const service = new PlatformService(
      prisma as never,
      { enqueue } as never,
      { flush: jest.fn() } as never,
      { record } as never,
      idleBooks(),
    );
    return { service, enqueue, record };
  }

  it('texts the conductor and the wakala only after a new paid cash-out', async () => {
    const { service, enqueue, record } = platform();
    await service.withdrawToWakala(
      {
        id: 'cond-1',
        role: UserRole.CONDUCTOR,
        phone: '+255714000001',
        firstName: 'Juma',
        lastName: 'Omari',
      } as never,
      { tillNumber: '11112222', amount: 100_000 },
    );
    expect(record).toHaveBeenCalledTimes(1);
    const types = enqueue.mock.calls.map((call) => call[1]);
    expect(types).toEqual([
      'CONDUCTOR_WITHDRAWAL_SUCCESS',
      'WAKALA_WITHDRAWAL_RECEIVED',
    ]);
    expect(enqueue.mock.calls[0][2]).toContain('TZS 100,000');
    expect(enqueue.mock.calls[0][2]).toContain('WD-0001');
    expect(enqueue.mock.calls[1][2]).toContain('TZS 600,000');
  });

  it('does not send success SMS for a replay, pending, or rejected withdrawal', async () => {
    const replay = platform();
    replay.record.mockResolvedValue({
      reference: 'WD-0001',
      balanceAfter: 600_000,
      alreadyPosted: true,
    });
    await replay.service.withdrawToWakala(
      {
        id: 'cond-1',
        role: UserRole.CONDUCTOR,
        phone: '+255714000001',
        firstName: 'Juma',
        lastName: 'Omari',
      } as never,
      { tillNumber: '11112222', amount: 100_000 },
    );
    expect(replay.record).toHaveBeenCalledTimes(1);
    expect(replay.enqueue).not.toHaveBeenCalled();

    const withdrawal = {
      id: 'wd-1',
      reference: 'WD-1',
      amount: 100_000,
      status: WithdrawalStatus.PENDING,
      agentUserId: 'agent-1',
      conductorUserId: 'cond-1',
      notes: null,
    };
    const enqueue = jest.fn();
    const record = jest.fn();
    const prisma = {
      user: { findUnique: jest.fn() },
      withdrawal: {
        findUnique: jest.fn().mockResolvedValue(withdrawal),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          ...withdrawal,
          ...data,
        })),
      },
      auditLog: { create: jest.fn() },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          withdrawal: prisma.withdrawal,
          auditLog: prisma.auditLog,
        }),
    };
    const admin = new AdminService(prisma as never, { enqueue } as never, {
      record,
    } as never);
    await expect(
      admin.markWithdrawalPaid({ id: 'admin-1', role: UserRole.ADMIN } as never, 'wd-1'),
    ).rejects.toThrow('Only APPROVED');
    await admin.rejectWithdrawal(
      { id: 'admin-1', role: UserRole.ADMIN } as never,
      'wd-1',
      {},
    );
    expect(enqueue).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});

describe('passenger phone identity', () => {
  function issue(existing: unknown) {
    const customerCreate = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'cust-1',
      ...data,
    }));
    const findFirst = jest.fn().mockResolvedValue(existing);
    const prisma = {
      card: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      customer: { findFirst },
      wallet: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          customer: { create: customerCreate, update: jest.fn() },
          wallet: {
            create: jest.fn(async ({ data }: { data: { publicCode: string } }) => ({
              id: 'wallet-1',
              balance: 0,
              publicCode: data.publicCode,
              status: 'ACTIVE',
            })),
          },
          card: {
            create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
              ...data,
              status: 'ACTIVE',
            })),
          },
        }),
    };
    const service = new PlatformService(
      prisma as never,
      { enqueue: jest.fn().mockResolvedValue({}) } as never,
      { flush: jest.fn() } as never,
      {} as never,
      idleBooks(),
    );
    return { service, customerCreate, findFirst };
  }

  const dto = {
    firstName: 'Neema',
    lastName: 'Ally',
    phone: '0712345678',
    nida: NIDA,
    nfcUid: '04AABBCC',
    cardNumber: 'BP-1001',
    initialLoad: 0,
  };

  it('normalizes the phone, rejects a duplicate, and stores no email', async () => {
    const fresh = issue(null);
    const created = await fresh.service.issueCard(dto as never);
    expect(created.customer.phone).toBe(PHONE);
    expect(fresh.customerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ email: expect.anything() }),
      }),
    );
    expect(fresh.customerCreate.mock.calls[0][0].data.phone).toBe(PHONE);
    expect(JSON.stringify(fresh.customerCreate.mock.calls[0][0].data)).not.toContain(
      'gmail.com',
    );
    const lookup = fresh.findFirst.mock.calls[0][0].where.OR[0].phone.in;
    expect(lookup).toEqual(expect.arrayContaining([PHONE, '0712345678']));

    const duplicate = issue({
      id: 'cust-1',
      phone: PHONE,
      nida: '20000101111111111111',
      wallet: { id: 'wallet-1' },
    });
    await expect(duplicate.service.issueCard(dto as never)).rejects.toThrow(
      'Phone number is already registered',
    );
    expect(duplicate.customerCreate).not.toHaveBeenCalled();
  });
});

describe('temporary password generator', () => {
  it('uses cryptographic randomness and is not derived from identity', () => {
    const samples = new Set(
      Array.from({ length: 8 }, () => generateTemporaryPassword()),
    );
    expect(samples.size).toBe(8);
    for (const sample of samples) {
      expect(sample).not.toContain('712345678');
      expect(sample).not.toContain(NIDA.slice(0, 8));
    }
  });
});

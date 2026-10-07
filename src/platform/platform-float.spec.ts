import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  UserRole,
  UserStatus,
  WakalaFloatTransactionType,
  WithdrawalStatus,
} from '../generated/prisma';
import { AdminService } from '../admin/admin.service';
import { idleBooks } from '../financial/idle-books';
import { PlatformService } from './platform.service';

function agentUser() {
  return {
    id: 'agent-1',
    role: UserRole.AGENT,
    status: UserStatus.ACTIVE,
    phone: '+255712000001',
    firstName: 'Asha',
    lastName: 'Juma',
    tillNumber: '1111-2222',
  };
}

function walletFixture() {
  return {
    id: 'wallet-1',
    balance: 1000,
    status: 'ACTIVE',
    publicCode: 'W1',
    customer: {
      id: 'cust-1',
      firstName: 'Neema',
      lastName: 'Ally',
      phone: '+255713000001',
      status: UserStatus.ACTIVE,
    },
  };
}

describe('passenger top-up float', () => {
  function setup(assertCanDebit = jest.fn().mockResolvedValue({ balance: 500_000 })) {
    const order: string[] = [];
    const record = jest.fn(async () => {
      order.push('record');
      return { reference: 'TU-1' };
    });
    const walletUpdate = jest.fn(async () => {
      order.push('wallet');
      return { ...walletFixture(), balance: 51_000 };
    });
    const topUpCreate = jest.fn(async () => {
      order.push('topup');
      return { id: 'top-1', reference: 'TU-0001' };
    });
    const prisma = {
      card: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'card-1',
          serialNumber: 'BP1',
          nfcUid: 'UID1',
          status: 'ACTIVE',
          wallet: walletFixture(),
        }),
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          wallet: { update: walletUpdate },
          card: { findFirst: jest.fn().mockResolvedValue({ id: 'card-1' }) },
          topUp: {
            create: topUpCreate,
            findUnique: jest.fn().mockResolvedValue(null),
          },
          smsOutbox: { create: jest.fn().mockResolvedValue({ id: 'sms-1' }) },
        };
        return fn(tx);
      },
    };
    const floats = {
      assertCanDebit: jest.fn(async () => {
        order.push('assert');
        return assertCanDebit();
      }),
      record,
      getBalance: jest.fn().mockResolvedValue({
        agentUserId: 'agent-1',
        balance: 500_000,
        currency: 'TZS',
      }),
      listTransactions: jest.fn().mockResolvedValue({
        page: 1,
        limit: 50,
        total: 1,
        transactions: [{ reference: 'FF-1', type: 'FLOAT_FUNDING' }],
      }),
    };
    const service = new PlatformService(
      prisma as never,
      { enqueue: jest.fn().mockResolvedValue({}) } as never,
      { flush: jest.fn() } as never,
      floats as never,
      idleBooks(),
    );
    return { service, order, walletUpdate, topUpCreate, record, floats };
  }

  it('debits float and credits the passenger wallet on success', async () => {
    const { service, order, record, topUpCreate } = setup();
    const result = await service.topUp(agentUser() as never, {
      serialNumber: 'BP1',
      amount: 50_000,
    });
    expect(result.success).toBe(true);
    expect(order.indexOf('assert')).toBeLessThan(order.indexOf('wallet'));
    expect(order).toEqual(['assert', 'wallet', 'topup', 'record']);
    expect(topUpCreate).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentUserId: 'agent-1',
        type: WakalaFloatTransactionType.PASSENGER_TOPUP,
        amount: 50_000,
        topUpId: 'top-1',
      }),
    );
  });

  it('does not credit the wallet or post float when float is insufficient', async () => {
    const { service, walletUpdate, record } = setup(async () => {
      throw new BadRequestException('Insufficient float balance.');
    });
    await expect(
      service.topUp(agentUser() as never, { serialNumber: 'BP1', amount: 50_000 }),
    ).rejects.toThrow('Insufficient float balance.');
    expect(walletUpdate).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('does not post float when the wallet credit fails', async () => {
    const ctx = setup();
    ctx.walletUpdate.mockRejectedValueOnce(new Error('wallet write failed'));
    await expect(
      ctx.service.topUp(agentUser() as never, {
        serialNumber: 'BP1',
        amount: 50_000,
      }),
    ).rejects.toThrow('wallet write failed');
    expect(ctx.record).not.toHaveBeenCalled();
    expect(ctx.topUpCreate).not.toHaveBeenCalled();
  });

  it('lets a wakala read only their own float and history', async () => {
    const { service, floats } = setup();
    await expect(
      service.getFloat({ ...agentUser(), role: UserRole.CONDUCTOR } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const balance = await service.getFloat(agentUser() as never);
    const history = await service.listFloatTransactions(agentUser() as never);
    expect(balance.balance).toBe(500_000);
    expect(floats.getBalance).toHaveBeenCalledWith('agent-1');
    expect(floats.listTransactions).toHaveBeenCalledWith('agent-1', 1, 20);
    expect(history.total).toBe(1);
  });
});

describe('conductor withdrawal float', () => {
  function setup() {
    const record = jest.fn().mockResolvedValue({
      reference: 'WD-0001',
      balanceAfter: 600_000,
      alreadyPosted: false,
    });
    const prisma = {
      user: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'agent-used',
            role: UserRole.AGENT,
            status: UserStatus.ACTIVE,
            firstName: 'Asha',
            lastName: 'Juma',
            phone: '+255712000001',
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
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
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
          smsOutbox: { create: jest.fn().mockResolvedValue({ id: 'sms-1' }) },
          auditLog: { create: jest.fn().mockResolvedValue({}) },
        };
        return fn(tx);
      },
    };
    const service = new PlatformService(
      prisma as never,
      { enqueue: jest.fn().mockResolvedValue({}) } as never,
      { flush: jest.fn() } as never,
      { record } as never,
      idleBooks(),
    );
    return { service, record };
  }

  it('credits the till wakala when the conductor withdrawal is paid', async () => {
    const { service, record } = setup();
    const result = await service.withdrawToWakala(
      {
        id: 'cond-1',
        role: UserRole.CONDUCTOR,
        phone: '+255714000001',
        firstName: 'Juma',
        lastName: 'Omari',
      } as never,
      { tillNumber: '11112222', amount: 100_000 },
    );
    expect(result.success).toBe(true);
    expect(record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentUserId: 'agent-used',
        type: WakalaFloatTransactionType.CONDUCTOR_WITHDRAWAL,
        amount: 100_000,
        withdrawalId: 'wd-1',
      }),
    );
  });
});

describe('admin float funding and withdrawal states', () => {
  const admin = { id: 'admin-1', role: UserRole.ADMIN } as never;
  const agent = {
    id: 'agent-1',
    role: UserRole.AGENT,
    firstName: 'Asha',
    lastName: 'Juma',
    tillNumber: '1111-2222',
    phone: '+255712000001',
  };

  function setup(status: WithdrawalStatus, conductorUserId: string | null = 'cond-1') {
    const record = jest.fn().mockResolvedValue({
      reference: 'FF-1',
      balanceBefore: 0,
      balanceAfter: 500_000,
    });
    const withdrawal = {
      id: 'wd-1',
      reference: 'WD-1',
      amount: 100_000,
      status,
      agentUserId: 'agent-1',
      conductorUserId,
      notes: null,
    };
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(agent) },
      withdrawal: {
        findUnique: jest.fn().mockResolvedValue(withdrawal),
        update: jest.fn().mockImplementation(async ({ data }) => ({
          ...withdrawal,
          ...data,
        })),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          withdrawal: {
            findUnique: prisma.withdrawal.findUnique,
            update: prisma.withdrawal.update,
          },
          auditLog: prisma.auditLog,
          wakalaFloatTransaction: {
            findUnique: jest.fn().mockResolvedValue(null),
          },
        }),
    };
    const floats = {
      record,
      getBalance: jest.fn().mockResolvedValue({
        agentUserId: 'agent-1',
        balance: 500_000,
        currency: 'TZS',
        updatedAt: null,
      }),
      listTransactions: jest.fn().mockResolvedValue({
        page: 1,
        limit: 50,
        total: 0,
        transactions: [],
      }),
      nextFundingReference: jest.fn().mockResolvedValue('FF-GENERATED'),
    };
    const service = new AdminService(
      prisma as never,
      { enqueue: jest.fn() } as never,
      floats as never,
    );
    return { service, record, prisma, floats };
  }

  it('lets admin fund a wakala and writes an audit log', async () => {
    const { service, record, prisma } = setup(WithdrawalStatus.PENDING);
    const result = await service.fundWakalaFloat(admin, 'agent-1', {
      amount: 500_000,
      reason: 'Opening float',
    });
    expect(result.balanceAfter).toBe(500_000);
    expect(record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentUserId: 'agent-1',
        type: WakalaFloatTransactionType.FLOAT_FUNDING,
        amount: 500_000,
        fundingChannel: 'ADMIN',
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'FLOAT_FUND' }),
      }),
    );
  });

  it('refuses funding from a non-admin', async () => {
    const { service, record } = setup(WithdrawalStatus.PENDING);
    await expect(
      service.fundWakalaFloat(
        { id: 'agent-1', role: UserRole.AGENT } as never,
        'agent-1',
        { amount: 500_000 },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(record).not.toHaveBeenCalled();
  });

  it('does not credit float for a pending withdrawal', async () => {
    const { service, record } = setup(WithdrawalStatus.PENDING);
    await expect(service.markWithdrawalPaid(admin, 'wd-1')).rejects.toThrow(
      'Only APPROVED withdrawals can be marked paid',
    );
    expect(record).not.toHaveBeenCalled();
  });

  it('does not credit float when a withdrawal is rejected', async () => {
    const { service, record, prisma } = setup(WithdrawalStatus.PENDING);
    prisma.withdrawal.update.mockResolvedValue({
      id: 'wd-1',
      reference: 'WD-1',
      amount: 100_000,
      status: WithdrawalStatus.REJECTED,
    });
    prisma.$transaction = undefined as never;
    await service.rejectWithdrawal(admin, 'wd-1', {});
    expect(record).not.toHaveBeenCalled();
  });

  it('credits float only when an approved conductor withdrawal is marked paid', async () => {
    const paid = setup(WithdrawalStatus.APPROVED, 'cond-1');
    await paid.service.markWithdrawalPaid(admin, 'wd-1');
    expect(paid.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentUserId: 'agent-1',
        type: WakalaFloatTransactionType.CONDUCTOR_WITHDRAWAL,
        withdrawalId: 'wd-1',
      }),
    );

    const platformOnly = setup(WithdrawalStatus.APPROVED, null);
    await platformOnly.service.markWithdrawalPaid(admin, 'wd-1');
    expect(platformOnly.record).not.toHaveBeenCalled();
  });
});

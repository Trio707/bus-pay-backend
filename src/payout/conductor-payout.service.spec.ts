import { createHmac } from 'node:crypto';

import { BadRequestException } from '@nestjs/common';
import { UserRole, UserStatus, WakalaFloatTransactionType } from '../generated/prisma';
import { CommissionService } from '../financial/commission.service';
import { idleBooks } from '../financial/idle-books';
import { LedgerService } from '../financial/ledger.service';
import { BooksService } from '../financial/books.service';
import { PlatformService } from '../platform/platform.service';
import { ConductorPayoutService } from './conductor-payout.service';
import { maskAccount, maskMobile } from './payout-mask';

const conductor = {
  id: 'cond-1',
  role: UserRole.CONDUCTOR,
  status: UserStatus.ACTIVE,
  phone: '+255714000001',
  firstName: 'Juma',
  lastName: 'Omari',
};

describe('conductor electronic payouts', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function harness(options?: {
    gross?: number;
    createPayout?: jest.Mock;
    books?: ReturnType<typeof idleBooks>;
  }) {
    const gross = options?.gross ?? 100_000;
    const payouts: Array<Record<string, any>> = [];
    const withdrawals: Array<Record<string, any>> = [];
    const audits: Array<Record<string, any>> = [];
    const messages: Array<{ type: string; message: string }> = [];
    const tails = new Map<string, Promise<void>>();
    const floats = jest.fn().mockResolvedValue({
      reference: 'WD-1',
      balanceAfter: 100_000,
      alreadyPosted: false,
    });

    const acquire = (key: string) => {
      const prev = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      tails.set(
        key,
        prev.then(() => gate),
      );
      return prev.then(() => release);
    };

    const findPayout = (where: Record<string, any>) => {
      if (where.id) return payouts.find((row) => row.id === where.id) ?? null;
      if (where.reference) return payouts.find((row) => row.reference === where.reference) ?? null;
      if (where.providerReference) {
        return payouts.find((row) => row.providerReference === where.providerReference) ?? null;
      }
      const pair = where.conductorUserId_idempotencyKey;
      if (pair) {
        return (
          payouts.find(
            (row) =>
              row.conductorUserId === pair.conductorUserId &&
              row.idempotencyKey === pair.idempotencyKey,
          ) ?? null
        );
      }
      return null;
    };

    const payoutApi = {
      findUnique: jest.fn(async ({ where, include }: { where: Record<string, any>; include?: { conductor?: unknown } }) => {
        const row = findPayout(where);
        if (!row) return null;
        if (include?.conductor) return { ...row, conductor: { phone: conductor.phone } };
        return row;
      }),
      findFirst: jest.fn(async ({ where }: { where: Record<string, any> }) => findPayout(where)),
      findMany: jest.fn(async () =>
        payouts.map((row) => ({
          ...row,
          conductor: {
            id: conductor.id,
            firstName: conductor.firstName,
            lastName: conductor.lastName,
            phone: conductor.phone,
          },
        })),
      ),
      count: jest.fn(async () => payouts.length),
      aggregate: jest.fn(async ({ where }: { where: { conductorUserId?: string; status?: { in: string[] } } }) => ({
        _sum: {
          amount: payouts
            .filter((row) => {
              if (where.conductorUserId && row.conductorUserId !== where.conductorUserId) return false;
              if (where.status?.in && !where.status.in.includes(row.status)) return false;
              return true;
            })
            .reduce((sum, row) => sum + row.amount, 0),
        },
      })),
      create: jest.fn(async ({ data }: { data: Record<string, any> }) => {
        const row = {
          id: `po-${payouts.length + 1}`,
          accountName: null,
          providerReference: null,
          failureReason: null,
          processingAt: null,
          completedAt: null,
          failedAt: null,
          requestedAt: new Date(),
          ...data,
        };
        payouts.push(row);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: { id: string; status: string }; data: Record<string, any> }) => {
        const row = payouts.find((item) => item.id === where.id && item.status === where.status);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    };

    const prisma = {
      conductorPayout: payoutApi,
      terminal: {
        findFirst: jest.fn().mockResolvedValue({ id: 'term-1', terminalCode: 'DLD-C0001' }),
      },
      user: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'agent-1',
            role: UserRole.AGENT,
            status: UserStatus.ACTIVE,
            firstName: 'Asha',
            lastName: 'Juma',
            phone: '+255712000001',
            tillNumber: '1111-2222',
          },
        ]),
      },
      paymentTransaction: {
        aggregate: jest.fn(async () => ({ _sum: { amount: gross } })),
      },
      withdrawal: {
        aggregate: jest.fn(async () => ({
          _sum: { amount: withdrawals.reduce((sum, row) => sum + row.amount, 0) },
        })),
        findUnique: jest.fn(async () => null),
        create: jest.fn(async ({ data }: { data: Record<string, any> }) => {
          const row = { id: `wd-${withdrawals.length + 1}`, ...data };
          withdrawals.push(row);
          return row;
        }),
      },
      auditLog: {
        create: jest.fn(async ({ data }: { data: Record<string, any> }) => {
          audits.push(data);
          return data;
        }),
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        let release = () => {};
        const tx = {
          $queryRaw: jest.fn(async (_query: TemplateStringsArray, key: string) => {
            release = await acquire(String(key));
            return [];
          }),
          conductorPayout: payoutApi,
          paymentTransaction: prisma.paymentTransaction,
          withdrawal: prisma.withdrawal,
          auditLog: prisma.auditLog,
        };
        try {
          return await fn(tx);
        } finally {
          release();
        }
      },
    };

    const provider = {
      createPayout:
        options?.createPayout ??
        jest.fn(async (request: { reference: string }) => ({
          outcome: 'ACCEPTED' as const,
          providerReference: `sandbox-${request.reference}`,
        })),
      getPayoutStatus: jest.fn(async () => 'PROCESSING' as const),
    };
    const enqueue = jest.fn(async (_phone: string, type: string, message: string) => {
      messages.push({ type, message });
      return { id: 'sms' };
    });
    const service = new ConductorPayoutService(
      prisma as never,
      { enqueue } as never,
      { flush: jest.fn() } as never,
      provider,
      options?.books ?? idleBooks(),
    );
    const platform = new PlatformService(
      prisma as never,
      { enqueue } as never,
      { flush: jest.fn() } as never,
      { record: floats } as never,
      idleBooks(),
    );
    return { service, platform, provider, payouts, withdrawals, audits, messages, floats, enqueue };
  }

  function mobile(amount: number, idempotencyKey: string) {
    return {
      method: 'MOBILE_MONEY' as const,
      provider: 'MPESA',
      mobileNumber: '0712345678',
      amount,
      idempotencyKey,
    };
  }

  beforeEach(() => {
    process.env.PAYOUT_MOBILE_PROVIDERS = 'MPESA,AIRTEL';
    process.env.PAYOUT_BANK_PROVIDERS = 'NMB';
    process.env.PAYOUT_WEBHOOK_SECRET = 'test-webhook-secret';
  });

  function quotedBooks() {
    const books = idleBooks();
    books.quoteWithdrawal = async (amount: number) => ({
      fee: 3_500,
      tier: '100000 <= amount < 200000',
      currency: 'TZS' as const,
      netAmount: amount,
      totalDebit: amount + 3_500,
    });
    return books;
  }

  it('quotes the amount the conductor receives and does not reserve funds', async () => {
    const books = new BooksService(
      { pricingPolicy: { findUnique: async () => null } } as never,
      new LedgerService({} as never),
      new CommissionService({} as never),
    );
    const { service, payouts } = harness({ books: books as never });
    const quote = await service.quote(100_000);
    expect(quote).toMatchObject({
      amount: 100_000,
      fee: 3_500,
      netAmount: 100_000,
      totalDebit: 103_500,
    });
    expect(payouts).toHaveLength(0);
  });

  it('rejects a 100,000 receive request when earnings cover only the receive amount', async () => {
    const { service, payouts } = harness({ gross: 100_000, books: quotedBooks() });
    await expect(
      service.request(conductor as never, mobile(100_000, 'idem-short')),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(payouts).toHaveLength(0);
  });

  it('reserves 103,500 when earnings cover a 100,000 receive amount plus the fee', async () => {
    const { service, payouts } = harness({ gross: 103_500, books: quotedBooks() });
    const result = await service.request(conductor as never, mobile(100_000, 'idem-cover'));
    expect(result.amount).toBe(100_000);
    expect(result.fee).toBe(3_500);
    expect(result.totalDebit).toBe(103_500);
    expect(payouts[0]).toMatchObject({
      amount: 100_000,
      platformFee: 3_500,
      totalDebit: 103_500,
      status: 'PROCESSING',
    });
  });

  it('masks destinations and keeps secrets out of the view', () => {
    expect(maskMobile('+255712345678')).toBe('07******78');
    expect(maskAccount('1234567890')).toBe('********7890');
  });

  it('reserves a mobile payout and stays processing until a signed callback', async () => {
    const { service, payouts, messages, floats } = harness();
    const result = await service.request(conductor as never, mobile(85_000, 'idem-mobile-1'));
    expect(result.status).toBe('PROCESSING');
    expect(result.success).toBe(true);
    expect(result.message).toContain('not a completed transfer');
    expect(result.destination).toBe('07******78');
    expect(JSON.stringify(result)).not.toContain('712345678');
    expect(JSON.stringify(result)).not.toContain('test-webhook-secret');
    expect(payouts[0].destination).toBe('+255712345678');
    expect(floats).not.toHaveBeenCalled();
    expect(messages.map((row) => row.type)).toEqual(['CONDUCTOR_PAYOUT_PENDING']);
  });

  it('completes once from the provider callback and ignores a replay', async () => {
    const { service, messages, audits } = harness();
    const created = await service.request(conductor as never, mobile(85_000, 'idem-mobile-2'));
    const body = JSON.stringify({
      providerReference: created.providerReference,
      status: 'COMPLETED',
    });
    const signature = createHmac('sha256', 'test-webhook-secret').update(body).digest('hex');
    const first = await service.handleWebhook(Buffer.from(body), signature);
    const second = await service.handleWebhook(Buffer.from(body), signature);
    expect(first.status).toBe('COMPLETED');
    expect(second.status).toBe('COMPLETED');
    expect(messages.filter((row) => row.type === 'CONDUCTOR_PAYOUT_COMPLETED')).toHaveLength(1);
    expect(audits.filter((row) => row.action === 'CONDUCTOR_PAYOUT_COMPLETED')).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain('712345678');
    expect(JSON.stringify(audits)).not.toContain('PIN');
  });

  it('releases reserved funds when the provider rejects or the callback fails', async () => {
    const rejected = harness({
      createPayout: jest.fn(async () => ({ outcome: 'REJECTED' as const, reason: 'Sandbox rejected' })),
    });
    const failed = await rejected.service.request(conductor as never, mobile(40_000, 'idem-reject'));
    expect(failed.status).toBe('FAILED');
    expect(rejected.payouts[0].status).toBe('FAILED');

    const { service } = harness();
    const created = await service.request(conductor as never, mobile(40_000, 'idem-fail-cb'));
    const body = JSON.stringify({
      providerReference: created.providerReference,
      status: 'FAILED',
      failureReason: 'provider declined',
    });
    const signature = createHmac('sha256', 'test-webhook-secret').update(body).digest('hex');
    const result = await service.handleWebhook(Buffer.from(body), signature);
    expect(result.status).toBe('FAILED');
    const retry = await service.request(conductor as never, mobile(100_000, 'idem-after-release'));
    expect(retry.status).toBe('PROCESSING');
  });

  it('keeps funds reserved when the provider times out', async () => {
    const { service, payouts, provider } = harness({
      createPayout: jest.fn(async () => {
        throw new Error('timeout');
      }),
    });
    const result = await service.request(conductor as never, mobile(50_000, 'idem-timeout'));
    expect(result.status).toBe('PENDING');
    expect(payouts[0].status).toBe('PENDING');
    await expect(
      service.request(conductor as never, mobile(60_000, 'idem-timeout-2')),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(provider.createPayout).toHaveBeenCalledTimes(1);
  });

  it('does not call the provider twice for the same idempotency key', async () => {
    const { service, provider, payouts } = harness();
    const first = await service.request(conductor as never, mobile(10_000, 'idem-same'));
    const second = await service.request(conductor as never, mobile(10_000, 'idem-same'));
    expect(second.replay).toBe(true);
    expect(second.id).toBe(first.id);
    expect(provider.createPayout).toHaveBeenCalledTimes(1);
    expect(payouts).toHaveLength(1);
  });

  it('rejects an unsupported provider before reserving money', async () => {
    const { service, payouts, provider } = harness();
    await expect(
      service.request(conductor as never, { ...mobile(10_000, 'idem-nope'), provider: 'CRDB' }),
    ).rejects.toThrow('Provider is not supported');
    expect(payouts).toHaveLength(0);
    expect(provider.createPayout).not.toHaveBeenCalled();
  });

  it('accepts a bank payout without moving wakala float', async () => {
    const { service, floats } = harness();
    const result = await service.request(conductor as never, {
      method: 'BANK',
      provider: 'NMB',
      accountNumber: '1234567890',
      accountName: 'Juma Omari',
      amount: 25_000,
      idempotencyKey: 'idem-bank-1',
    });
    expect(result.status).toBe('PROCESSING');
    expect(result.destination).toBe('********7890');
    expect(JSON.stringify(result)).not.toContain('1234567890');
    expect(floats).not.toHaveBeenCalled();
    expect(result.providerReference).toMatch(/^sandbox-/);
  });

  it('lets one of two concurrent payouts reserve the balance', async () => {
    const { service, payouts } = harness({ gross: 100_000 });
    const results = await Promise.allSettled([
      service.request(conductor as never, mobile(80_000, 'idem-race-a')),
      service.request(conductor as never, mobile(80_000, 'idem-race-b')),
    ]);
    const fulfilled = results.filter((row) => row.status === 'fulfilled');
    const rejected = results.filter((row) => row.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(payouts.filter((row) => row.status === 'PROCESSING' || row.status === 'PENDING')).toHaveLength(1);
    expect(payouts[0].amount).toBe(80_000);
  });

  it('does not let a cash-out and an electronic payout spend the same earnings', async () => {
    const { service, platform, payouts, withdrawals, floats } = harness({ gross: 100_000 });
    const results = await Promise.allSettled([
      service.request(conductor as never, mobile(80_000, 'idem-mix-payout')),
      platform.withdrawToWakala(conductor as never, { tillNumber: '11112222', amount: 80_000 }),
    ]);
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((row) => row.status === 'rejected')).toHaveLength(1);
    const held = payouts
      .filter((row) => ['PENDING', 'PROCESSING', 'COMPLETED'].includes(row.status))
      .reduce((sum, row) => sum + row.amount, 0);
    const cashed = withdrawals.reduce((sum, row) => sum + row.amount, 0);
    expect(held + cashed).toBe(80_000);
    if (cashed > 0) {
      expect(floats).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ type: WakalaFloatTransactionType.CONDUCTOR_WITHDRAWAL }),
      );
    }
  });

  it('refuses an unsigned callback and a callback when no secret is configured', async () => {
    const { service, payouts } = harness();
    const created = await service.request(conductor as never, mobile(5_000, 'idem-sig'));
    const body = JSON.stringify({ providerReference: created.providerReference, status: 'COMPLETED' });
    await expect(service.handleWebhook(Buffer.from(body), 'not-the-signature')).rejects.toThrow(
      'Invalid payout callback signature',
    );
    delete process.env.PAYOUT_WEBHOOK_SECRET;
    await expect(
      service.handleWebhook(Buffer.from(body), createHmac('sha256', 'x').update(body).digest('hex')),
    ).rejects.toThrow('Payout webhook is not configured');
    expect(payouts[0].status).toBe('PROCESSING');
  });

  it('lists masked payouts for admin', async () => {
    const { service } = harness();
    await service.request(conductor as never, mobile(5_000, 'idem-admin'));
    const listed = await service.listForAdmin();
    expect(listed.payouts[0].destination).toBe('07******78');
    expect(listed.payouts[0].conductor.name).toBe('JUMA OMARI');
    expect(JSON.stringify(listed)).not.toContain('test-webhook-secret');
  });
});

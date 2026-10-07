import { AsyncLocalStorage } from 'node:async_hooks';
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  UserRole,
  WakalaFloatTransactionType,
} from '../generated/prisma';
import { idleBooks } from '../financial/idle-books';
import { PlatformService } from './platform.service';
import { WakalaFloatService } from './wakala-float.service';

const agent = {
  id: 'agent-1',
  role: UserRole.AGENT,
  phone: '+255712000001',
} as never;

function registrationDto(initialLoad: number) {
  return {
    firstName: 'Neema',
    lastName: 'Ally',
    phone: '+255713000001',
    nfcUid: 'UID1',
    cardNumber: '123456789012',
    initialLoad,
  };
}

describe('wakala cash loads', () => {
  function registrationHarness() {
    const order: string[] = [];
    const committed: string[] = [];
    let issued = false;
    const record = jest.fn(async () => {
      order.push('record');
      return { reference: 'TU-REG' };
    });
    const assertCanDebit = jest.fn(async () => {
      order.push('assert');
    });
    const customerCreate = jest.fn(async () => {
      order.push('customer');
      return {
        id: 'cust-1',
        firstName: 'Neema',
        lastName: 'Ally',
        phone: '+255713000001',
      };
    });
    const walletCreate = jest.fn(async ({ data }: { data: { balance: number } }) => {
      order.push('wallet');
      return {
        id: 'wallet-1',
        publicCode: 'W1',
        balance: data.balance,
        status: 'ACTIVE',
      };
    });
    const prisma = {
      card: {
        findUnique: jest.fn(async ({ where }: { where: { nfcUid?: string } }) => {
          if (where.nfcUid && issued) return { id: 'card-1', nfcUid: where.nfcUid };
          return null;
        }),
        findFirst: jest.fn(async ({ where }: { where: { nfcUid?: { in?: string[] } | string; serialNumber?: string } }) => {
          const uid =
            typeof where.nfcUid === 'string'
              ? where.nfcUid
              : where.nfcUid?.in?.[0];
          if (uid && issued) return { id: 'card-1', nfcUid: uid };
          return null;
        }),
      },
      customer: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      wallet: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const staged: string[] = [];
        const tx = {
          customer: {
            create: async (args: unknown) => {
              staged.push('customer');
              return customerCreate(args);
            },
          },
          wallet: {
            create: async (args: { data: { balance: number } }) => {
              staged.push('wallet');
              return walletCreate(args);
            },
            update: jest.fn(),
          },
          card: {
            create: jest.fn(async () => {
              staged.push('card');
              issued = true;
              return {
                id: 'card-1',
                serialNumber: '123456789012',
                nfcUid: 'UID1',
                status: 'ACTIVE',
                issuedAt: new Date(),
              };
            }),
          },
          topUp: {
            findUnique: jest.fn().mockResolvedValue(null),
            create: jest.fn(async () => {
              staged.push('topup');
              return { id: 'top-reg', reference: 'TU-REG' };
            }),
          },
          smsOutbox: { create: jest.fn() },
        };
        try {
          const result = await fn(tx);
          committed.push(...staged);
          return result;
        } catch (error) {
          throw error;
        }
      },
    };
    const service = new PlatformService(
      prisma as never,
      { enqueue: jest.fn().mockResolvedValue({}) } as never,
      { flush: jest.fn() } as never,
      { assertCanDebit, record } as never,
      idleBooks(),
    );
    return { service, order, record, assertCanDebit, customerCreate, walletCreate, committed };
  }

  it('deducts the registration initial load from the wakala float', async () => {
    const { service, order, record, walletCreate } = registrationHarness();
    const result = await service.issueCard(registrationDto(20_000), agent);
    expect(result.success).toBe(true);
    expect(walletCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ balance: 20_000 }) }),
    );
    expect(order.indexOf('assert')).toBeLessThan(order.indexOf('customer'));
    expect(order).toContain('record');
    expect(record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentUserId: 'agent-1',
        type: WakalaFloatTransactionType.PASSENGER_TOPUP,
        amount: 20_000,
        topUpId: 'top-reg',
      }),
    );
    const posting = record.mock.calls[0][1] as {
      amount: number;
      type: WakalaFloatTransactionType;
      topUpId: string;
    };
    expect(posting).toMatchObject({
      type: WakalaFloatTransactionType.PASSENGER_TOPUP,
      amount: 20_000,
      topUpId: 'top-reg',
    });
  });

  it('does not touch float when registration has no initial load', async () => {
    const { service, record, assertCanDebit, walletCreate } = registrationHarness();
    await service.issueCard(registrationDto(0), agent);
    expect(assertCanDebit).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(walletCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ balance: 0 }) }),
    );
  });

  it('rejects registration when float is insufficient and creates nothing', async () => {
    const harness = registrationHarness();
    harness.assertCanDebit.mockRejectedValue(
      new BadRequestException('Insufficient float balance.'),
    );
    await expect(
      harness.service.issueCard(registrationDto(20_000), agent),
    ).rejects.toThrow('Insufficient float balance.');
    expect(harness.customerCreate).not.toHaveBeenCalled();
    expect(harness.walletCreate).not.toHaveBeenCalled();
    expect(harness.record).not.toHaveBeenCalled();
    expect(harness.committed).toEqual([]);
  });

  it('rolls back registration when a later write fails', async () => {
    const harness = registrationHarness();
    harness.customerCreate.mockRejectedValueOnce(new Error('customer write failed'));
    await expect(
      harness.service.issueCard(registrationDto(20_000), agent),
    ).rejects.toThrow('customer write failed');
    expect(harness.record).not.toHaveBeenCalled();
    expect(harness.committed).toEqual([]);
  });

  it('does not deduct float again when registration is retried', async () => {
    const { service, record } = registrationHarness();
    await service.issueCard(registrationDto(20_000), agent);
    await expect(
      service.issueCard(registrationDto(20_000), agent),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('replays one registration float posting only once on the ledger', async () => {
    const { service, record } = registrationHarness();
    await service.issueCard(registrationDto(20_000), agent);
    const posting = record.mock.calls[0][1];
    const book = ledger(500_000);
    const floats = new WakalaFloatService({} as never);
    await book.transaction((tx) => floats.record(tx as never, posting));
    await book.transaction((tx) => floats.record(tx as never, posting));
    expect(book.balance).toBe(480_000);
    expect(book.rows).toHaveLength(1);
  });
});

describe('card renewal cash load', () => {
  function renewalHarness() {
    const record = jest.fn().mockResolvedValue({ reference: 'TU-REN' });
    const assertCanDebit = jest.fn().mockResolvedValue(undefined);
    const walletUpdate = jest.fn().mockResolvedValue({
      id: 'wallet-1',
      publicCode: 'W1',
      balance: 11_000,
      status: 'ACTIVE',
    });
    const prisma = {
      card: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'card-1',
          serialNumber: 'BP1',
          nfcUid: null,
          status: 'ACTIVE',
          walletId: 'wallet-1',
          wallet: {
            id: 'wallet-1',
            balance: 1_000,
            publicCode: 'W1',
            status: 'ACTIVE',
            customer: {
              id: 'cust-1',
              firstName: 'Asha',
              lastName: 'Juma',
              phone: '+255712345678',
              status: 'ACTIVE',
            },
          },
        }),
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          card: {
            update: jest.fn().mockResolvedValue({
              id: 'card-1',
              serialNumber: 'BP1',
              nfcUid: null,
              status: 'ACTIVE',
              issuedAt: new Date(),
            }),
          },
          customer: { update: jest.fn() },
          wallet: { update: walletUpdate },
          topUp: {
            findUnique: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({ id: 'top-ren', reference: 'TU-REN' }),
          },
          smsOutbox: { create: jest.fn() },
        };
        return fn(tx);
      },
    };
    const service = new PlatformService(
      prisma as never,
      { enqueue: jest.fn().mockResolvedValue({}) } as never,
      { flush: jest.fn() } as never,
      { assertCanDebit, record } as never,
      idleBooks(),
    );
    return { service, record, assertCanDebit, walletUpdate };
  }

  it('deducts renewal funding from the wakala float', async () => {
    const { service, record, walletUpdate } = renewalHarness();
    await service.renewCard('BP1', { amount: 10_000 }, agent);
    expect(walletUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { balance: { increment: 10_000 } },
      }),
    );
    expect(record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentUserId: 'agent-1',
        type: WakalaFloatTransactionType.PASSENGER_TOPUP,
        amount: 10_000,
        topUpId: 'top-ren',
      }),
    );
  });

  it('does not post float when renewal adds no money', async () => {
    const { service, record, assertCanDebit, walletUpdate } = renewalHarness();
    await service.renewCard('BP1', { amount: 0 }, agent);
    expect(assertCanDebit).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(walletUpdate).not.toHaveBeenCalled();
  });

  it('rejects renewal funding when float is insufficient', async () => {
    const harness = renewalHarness();
    harness.assertCanDebit.mockRejectedValue(
      new BadRequestException('Insufficient float balance.'),
    );
    await expect(
      harness.service.renewCard('BP1', { amount: 10_000 }, agent),
    ).rejects.toThrow('Insufficient float balance.');
    expect(harness.walletUpdate).not.toHaveBeenCalled();
    expect(harness.record).not.toHaveBeenCalled();
  });

  it('does not deduct float twice when the same renewal posting is retried', async () => {
    const { service, record } = renewalHarness();
    await service.renewCard('BP1', { amount: 10_000 }, agent);
    const posting = record.mock.calls[0][1];
    const book = ledger(300_000);
    const floats = new WakalaFloatService({} as never);
    await book.transaction((tx) => floats.record(tx as never, posting));
    await book.transaction((tx) => floats.record(tx as never, posting));
    expect(book.balance).toBe(290_000);
    expect(book.rows).toHaveLength(1);
  });
});

describe('shared float lock for cash loads', () => {
  it('stops concurrent registration-sized loads from overspending one float', async () => {
    const book = ledger(50_000);
    const floats = new WakalaFloatService({} as never);
    const results = await Promise.allSettled([
      book.transaction((tx) =>
        floats.record(tx as never, {
          agentUserId: 'agent-1',
          type: WakalaFloatTransactionType.PASSENGER_TOPUP,
          amount: 40_000,
          reference: 'TU-REG-A',
          topUpId: 'top-a',
          reason: 'Card registration initial load',
        }),
      ),
      book.transaction((tx) =>
        floats.record(tx as never, {
          agentUserId: 'agent-1',
          type: WakalaFloatTransactionType.PASSENGER_TOPUP,
          amount: 40_000,
          reference: 'TU-REN-B',
          topUpId: 'top-b',
          reason: 'Card renewal load',
        }),
      ),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(book.balance).toBe(10_000);
    expect(book.rows).toHaveLength(1);
  });
});

type StoredTx = {
  id: string;
  agentUserId: string;
  type: WakalaFloatTransactionType;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  reference: string;
  topUpId: string | null;
  withdrawalId: string | null;
  externalReference: string | null;
};

function ledger(initial = 0) {
  const als = new AsyncLocalStorage<{ id: number }>();
  let seq = 0;
  let heldBy: number | null = null;
  const waiters: Array<() => void> = [];
  let balance = initial;
  const rows: StoredTx[] = [];

  async function acquire() {
    const store = als.getStore();
    if (!store) throw new Error('lock used outside a transaction');
    if (heldBy === store.id) return;
    while (heldBy !== null) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    heldBy = store.id;
  }

  function release() {
    const store = als.getStore();
    if (!store || heldBy !== store.id) return;
    heldBy = null;
    waiters.shift()?.();
  }

  const tx = {
    wakalaFloat: {
      upsert: jest.fn(async () => ({ id: 'float-1', balance })),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { balance: number };
          data: { balance: number };
        }) => {
          if (where.balance !== balance) return { count: 0 };
          balance = data.balance;
          return { count: 1 };
        },
      ),
    },
    wakalaFloatTransaction: {
      findUnique: jest.fn(async ({ where }: { where: Record<string, string> }) => {
        return (
          rows.find((row) =>
            Object.entries(where).every(
              ([key, value]) => row[key as keyof StoredTx] === value,
            ),
          ) ?? null
        );
      }),
      create: jest.fn(async ({ data }: { data: StoredTx }) => {
        const row = { ...data, id: `tx-${rows.length + 1}` };
        rows.push(row);
        return row;
      }),
    },
    $queryRaw: jest.fn(async () => {
      await acquire();
      return [{ id: 'float-1', balance }];
    }),
  };

  return {
    tx,
    rows,
    get balance() {
      return balance;
    },
    transaction<T>(fn: (client: typeof tx) => Promise<T>) {
      return als.run({ id: ++seq }, async () => {
        try {
          return await fn(tx);
        } finally {
          release();
        }
      });
    },
  };
}

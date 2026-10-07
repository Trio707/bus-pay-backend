import { AsyncLocalStorage } from 'node:async_hooks';
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  WakalaFloatFundingChannel,
  WakalaFloatTransactionType,
} from '../generated/prisma';
import { WakalaFloatService } from './wakala-float.service';

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
  let writes = 0;

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
          writes += 1;
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
    get writes() {
      return writes;
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

describe('WakalaFloatService', () => {
  const service = new WakalaFloatService({} as never);

  it('funds a wakala and records one FLOAT_FUNDING transaction', async () => {
    const book = ledger(0);
    const row = await book.transaction((tx) =>
      service.record(tx as never, {
        agentUserId: 'agent-1',
        type: WakalaFloatTransactionType.FLOAT_FUNDING,
        amount: 500_000,
        reference: 'FF-1',
        reason: 'Admin float funding',
        fundingChannel: WakalaFloatFundingChannel.ADMIN,
      }),
    );

    expect(book.balance).toBe(500_000);
    expect(row).toMatchObject({
      balanceBefore: 0,
      amount: 500_000,
      balanceAfter: 500_000,
      type: WakalaFloatTransactionType.FLOAT_FUNDING,
    });
    expect(book.rows).toHaveLength(1);
    expect(book.writes).toBe(1);
  });

  it('rejects a non-positive funding amount', async () => {
    const book = ledger(0);
    await expect(
      book.transaction((tx) =>
        service.record(tx as never, {
          agentUserId: 'agent-1',
          type: WakalaFloatTransactionType.FLOAT_FUNDING,
          amount: -1,
          reference: 'FF-bad',
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(book.balance).toBe(0);
    expect(book.rows).toHaveLength(0);
  });

  it('decreases float for a passenger top-up and keeps one ledger row', async () => {
    const book = ledger(500_000);
    await book.transaction((tx) =>
      service.record(tx as never, {
        agentUserId: 'agent-1',
        type: WakalaFloatTransactionType.PASSENGER_TOPUP,
        amount: 50_000,
        reference: 'TU-1',
        topUpId: 'top-1',
      }),
    );
    expect(book.balance).toBe(450_000);
    expect(book.rows[0]).toMatchObject({
      balanceBefore: 500_000,
      amount: 50_000,
      balanceAfter: 450_000,
    });
  });

  it('rejects a top-up when float is insufficient and does not post a row', async () => {
    const book = ledger(20_000);
    await expect(
      book.transaction((tx) =>
        service.record(tx as never, {
          agentUserId: 'agent-1',
          type: WakalaFloatTransactionType.PASSENGER_TOPUP,
          amount: 50_000,
          reference: 'TU-short',
          topUpId: 'top-short',
        }),
      ),
    ).rejects.toThrow('Insufficient float balance.');
    expect(book.balance).toBe(20_000);
    expect(book.rows).toHaveLength(0);
    expect(book.writes).toBe(0);
  });

  it('does not move float again when the same top-up is retried', async () => {
    const book = ledger(500_000);
    const posting = {
      agentUserId: 'agent-1',
      type: WakalaFloatTransactionType.PASSENGER_TOPUP,
      amount: 50_000,
      reference: 'TU-1',
      topUpId: 'top-1',
    };
    await book.transaction((tx) => service.record(tx as never, posting));
    await book.transaction((tx) => service.record(tx as never, posting));
    expect(book.balance).toBe(450_000);
    expect(book.rows).toHaveLength(1);
    expect(book.writes).toBe(1);
  });

  it('does not credit float from an unverified payment-provider reference', async () => {
    const book = ledger(100_000);
    await expect(
      book.transaction((tx) =>
        service.record(tx as never, {
          agentUserId: 'agent-1',
          type: WakalaFloatTransactionType.FLOAT_FUNDING,
          amount: 50_000,
          reference: 'SELCOM-CLAIM-1',
          fundingChannel: WakalaFloatFundingChannel.PAYMENT_PROVIDER,
          externalReference: 'typed-by-wakala',
        }),
      ),
    ).rejects.toThrow('verified provider transaction');
    expect(book.balance).toBe(100_000);
    expect(book.rows).toHaveLength(0);
  });

  it('increases only the wakala who processed a paid conductor withdrawal', async () => {
    const book = ledger(450_000);
    await book.transaction((tx) =>
      service.record(tx as never, {
        agentUserId: 'agent-used',
        type: WakalaFloatTransactionType.CONDUCTOR_WITHDRAWAL,
        amount: 100_000,
        reference: 'WD-1',
        withdrawalId: 'wd-1',
      }),
    );
    expect(book.balance).toBe(550_000);
    expect(book.rows[0].agentUserId).toBe('agent-used');
  });

  it('does not credit float twice for the same withdrawal', async () => {
    const book = ledger(450_000);
    const posting = {
      agentUserId: 'agent-used',
      type: WakalaFloatTransactionType.CONDUCTOR_WITHDRAWAL,
      amount: 100_000,
      reference: 'WD-1',
      withdrawalId: 'wd-1',
    };
    await book.transaction((tx) => service.record(tx as never, posting));
    await book.transaction((tx) => service.record(tx as never, posting));
    expect(book.balance).toBe(550_000);
    expect(book.rows).toHaveLength(1);
  });

  it('stops a second concurrent top-up from overspending the same float', async () => {
    const book = ledger(50_000);
    const results = await Promise.allSettled([
      book.transaction((tx) =>
        service.record(tx as never, {
          agentUserId: 'agent-1',
          type: WakalaFloatTransactionType.PASSENGER_TOPUP,
          amount: 40_000,
          reference: 'TU-A',
          topUpId: 'top-a',
        }),
      ),
      book.transaction((tx) =>
        service.record(tx as never, {
          agentUserId: 'agent-1',
          type: WakalaFloatTransactionType.PASSENGER_TOPUP,
          amount: 40_000,
          reference: 'TU-B',
          topUpId: 'top-b',
        }),
      ),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      BadRequestException,
    );
    expect(book.balance).toBe(10_000);
    expect(book.rows).toHaveLength(1);
    expect(book.writes).toBe(1);
  });

  it('rejects a stale balance write', async () => {
    const book = ledger(10_000);
    book.tx.wakalaFloat.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      book.transaction((tx) =>
        service.record(tx as never, {
          agentUserId: 'agent-1',
          type: WakalaFloatTransactionType.FLOAT_FUNDING,
          amount: 1,
          reference: 'FF-stale',
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(book.rows).toHaveLength(0);
  });

  it('locks the float row with SELECT FOR UPDATE', async () => {
    const book = ledger(0);
    await book.transaction((tx) =>
      service.record(tx as never, {
        agentUserId: 'agent-1',
        type: WakalaFloatTransactionType.FLOAT_FUNDING,
        amount: 1,
        reference: 'FF-lock',
      }),
    );
    const sql = book.tx.$queryRaw.mock.calls[0]?.[0];
    const text = Array.isArray(sql) ? sql.join('') : String(sql?.sql ?? sql);
    expect(text.toUpperCase()).toContain('FOR UPDATE');
  });
});

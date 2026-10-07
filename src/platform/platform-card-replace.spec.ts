import { BadRequestException, ConflictException } from '@nestjs/common';
import { CardStatus, UserRole } from '../generated/prisma';
import { idleBooks } from '../financial/idle-books';
import { PlatformService } from './platform.service';

const SERIAL = '123456789012';
const OLD_UID = '04A1B2C3D455';
const NEW_UID = '04:B1:C2:D3:E4:66';
const NEW_UID_STORED = '04:B1:C2:D3:E4:66';

const agent = { id: 'agent-1', role: UserRole.AGENT } as never;
const conductor = { id: 'cond-1', role: UserRole.CONDUCTOR } as never;

type CardRow = {
  id: string;
  serialNumber: string;
  nfcUid: string | null;
  status: string;
  walletId: string;
  replacedById: string | null;
  issuedAt: Date;
};

type WalletRow = {
  id: string;
  publicCode: string;
  customerId: string;
  balance: number;
  status: string;
};

type CustomerRow = {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  status: string;
  nida?: string;
};

function boot(options?: { empty?: boolean }) {
  const cards: CardRow[] = [];
  const wallets: WalletRow[] = [];
  const customers: CustomerRow[] = [];
  const payments: {
    id: string;
    reference: string;
    amount?: number;
    status?: string;
  }[] = [];
  const idempotencyRows: {
    scope: string;
    key: string;
    entityType: string;
    entityId: string;
  }[] = [];
  const topUps: { reference: string }[] = [];
  let cardSeq = 1;
  let customerSeq = 0;
  let walletSeq = 0;
  const counts = { customers: 0, wallets: 0, cards: 0 };
  const sms: { type: string; phone: string; message: string }[] = [];

  if (!options?.empty) {
    customers.push({
      id: 'cust-1',
      firstName: 'John',
      lastName: 'Mushi',
      phone: '+255713000001',
      status: 'ACTIVE',
    });
    wallets.push({
      id: 'wallet-1',
      publicCode: '999888777666',
      customerId: 'cust-1',
      balance: 35_000,
      status: 'ACTIVE',
    });
    cards.push({
      id: 'card-old',
      serialNumber: SERIAL,
      nfcUid: OLD_UID,
      status: CardStatus.ACTIVE,
      walletId: 'wallet-1',
      replacedById: null,
      issuedAt: new Date('2026-01-01T00:00:00Z'),
    });
  }

  function customerOf(wallet: WalletRow) {
    return customers.find((row) => row.id === wallet.customerId)!;
  }

  function hydrate(card: CardRow) {
    const wallet = wallets.find((row) => row.id === card.walletId)!;
    return { ...card, wallet: { ...wallet, customer: customerOf(wallet) } };
  }

  function matchCard(card: CardRow, where: Record<string, unknown>): boolean {
    if (!where) return true;
    if (Array.isArray(where.OR)) {
      return (where.OR as Record<string, unknown>[]).some((part) =>
        matchCard(card, part),
      );
    }
    if (typeof where.id === 'string' && card.id !== where.id) return false;
    if (typeof where.walletId === 'string' && card.walletId !== where.walletId) return false;
    if (
      typeof where.serialNumber === 'string' &&
      card.serialNumber !== where.serialNumber
    ) {
      return false;
    }
    if (typeof where.replacedById === 'string' && card.replacedById !== where.replacedById) {
      return false;
    }
    const uid = where.nfcUid as { in?: string[] } | string | undefined;
    if (typeof uid === 'string' && card.nfcUid !== uid) return false;
    if (uid && typeof uid === 'object' && uid.in && !uid.in.includes(card.nfcUid ?? '')) {
      return false;
    }
    const status = where.status as { in?: string[] } | string | undefined;
    if (typeof status === 'string' && card.status !== status) return false;
    if (status && typeof status === 'object' && status.in && !status.in.includes(card.status)) {
      return false;
    }
    return true;
  }

  function applyBalance(
    wallet: WalletRow,
    data: { balance?: { increment?: number; decrement?: number } },
  ) {
    if (data.balance?.increment) wallet.balance += data.balance.increment;
    if (data.balance?.decrement) wallet.balance -= data.balance.decrement;
    return { ...wallet, customer: customerOf(wallet) };
  }

  const record = jest.fn(async () => ({ reference: 'TU-1' }));
  const assertCanDebit = jest.fn(async () => undefined);

  let chain: Promise<unknown> = Promise.resolve();
  const tx = {
    card: {
      findFirst: async (args: { where: Record<string, unknown> }) => {
        const found = cards.find((card) => matchCard(card, args.where));
        return found ? hydrate(found) : null;
      },
      updateMany: async (args: {
        where: Record<string, unknown>;
        data: Partial<CardRow>;
      }) => {
        let count = 0;
        for (const card of cards) {
          if (!matchCard(card, args.where)) continue;
          Object.assign(card, args.data);
          count += 1;
        }
        return { count };
      },
      update: async (args: { where: { id: string }; data: Partial<CardRow> }) => {
        const card = cards.find((row) => row.id === args.where.id);
        if (!card) throw new Error('card missing');
        Object.assign(card, args.data);
        return hydrate(card);
      },
      create: async (args: { data: Omit<CardRow, 'id' | 'issuedAt' | 'replacedById'> & { replacedById?: string | null } }) => {
        const live = [CardStatus.ACTIVE, CardStatus.FROZEN];
        if (
          args.data.nfcUid &&
          cards.some((card) => card.nfcUid === args.data.nfcUid)
        ) {
          const error = new Error('unique uid') as Error & { code: string };
          error.code = 'P2002';
          throw error;
        }
        if (
          live.includes(args.data.status as CardStatus) &&
          cards.some(
            (card) =>
              card.serialNumber === args.data.serialNumber &&
              live.includes(card.status as CardStatus),
          )
        ) {
          const error = new Error('unique live serial') as Error & { code: string };
          error.code = 'P2002';
          throw error;
        }
        const row: CardRow = {
          id: `card-${++cardSeq}`,
          issuedAt: new Date(),
          replacedById: null,
          ...args.data,
        };
        cards.push(row);
        counts.cards += 1;
        return hydrate(row);
      },
    },
    customer: {
      update: async (args: { where: { id: string }; data: Partial<CustomerRow> }) => {
        const customer = customers.find((row) => row.id === args.where.id)!;
        Object.assign(customer, args.data);
        return customer;
      },
      create: async (args: { data: CustomerRow }) => {
        counts.customers += 1;
        const row = { ...args.data, id: `cust-new-${++customerSeq}` };
        customers.push(row);
        return row;
      },
    },
    wallet: {
      update: async (args: {
        where: { id: string };
        data: { balance?: { increment?: number; decrement?: number } };
      }) => {
        const wallet = wallets.find((row) => row.id === args.where.id)!;
        return applyBalance(wallet, args.data);
      },
      create: async (args: { data: WalletRow }) => {
        counts.wallets += 1;
        const row = {
          ...args.data,
          id: args.data.id ?? `wallet-new-${++walletSeq}`,
        };
        wallets.push(row);
        return { ...row, customer: customerOf(row) };
      },
    },
    topUp: {
      findUnique: async () => null,
      create: async (args: { data: { reference: string } }) => {
        topUps.push({ reference: args.data.reference });
        return { id: `top-${topUps.length}`, ...args.data };
      },
    },
    paymentTransaction: {
      findUnique: async ({ where }: { where: { reference?: string; id?: string } }) =>
        payments.find(
          (row) => row.reference === where.reference || row.id === where.id,
        ) ?? null,
      create: async (args: { data: { reference: string; amount?: number } }) => {
        const row = {
          id: `pay-${payments.length + 1}`,
          status: 'SUCCESS',
          ...args.data,
        };
        payments.push(row);
        return row;
      },
    },
    apiIdempotency: {
      findUnique: async ({
        where,
      }: {
        where: { scope_key: { scope: string; key: string } };
      }) =>
        idempotencyRows.find(
          (row) =>
            row.scope === where.scope_key.scope && row.key === where.scope_key.key,
        ) ?? null,
      create: async ({
        data,
      }: {
        data: { scope: string; key: string; entityType: string; entityId: string };
      }) => {
        if (
          idempotencyRows.some(
            (row) => row.scope === data.scope && row.key === data.key,
          )
        ) {
          const error = new Error('unique') as Error & { code: string };
          error.code = 'P2002';
          throw error;
        }
        idempotencyRows.push(data);
        return data;
      },
    },
  };

  const prisma = {
    card: {
      findFirst: async (args: {
        where: Record<string, unknown>;
        orderBy?: { issuedAt?: 'desc' };
      }) => {
        const found = cards
          .filter((card) => matchCard(card, args.where))
          .sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime());
        return found[0] ? hydrate(found[0]) : null;
      },
      findUnique: async () => null,
    },
    customer: {
      findFirst: async () => null,
      findUnique: async () => null,
    },
    wallet: {
      findFirst: async (args: { where: Record<string, unknown> }) => {
        const code = args.where?.OR as { publicCode?: { equals?: string } }[] | undefined;
        if (!code) return null;
        const wallet = wallets.find((row) =>
          code.some(
            (part) =>
              part.publicCode?.equals?.toLowerCase() === row.publicCode.toLowerCase(),
          ),
        );
        return wallet ? { ...wallet, customer: customerOf(wallet) } : null;
      },
      findUnique: async ({ where }: { where: { publicCode?: string } }) =>
        wallets.find((row) => row.publicCode === where.publicCode) ?? null,
    },
    terminal: {
      findFirst: async () => ({
        id: 'term-1',
        terminalCode: 'DLD-C0001',
        merchantId: 'mer-1',
        ownerUserId: 'cond-1',
        status: 'ACTIVE',
      }),
    },
    merchant: {
      findUnique: async () => ({
        id: 'mer-1',
        merchantCode: 'DLD-PLATFORM',
        name: 'BusPay Daladala',
        category: 'TRANSPORT',
        status: 'ACTIVE',
      }),
    },
    apiIdempotency: tx.apiIdempotency,
    paymentTransaction: {
      findUnique: async ({ where }: { where: { id?: string; reference?: string } }) => {
        const row = payments.find(
          (payment) => payment.id === where.id || payment.reference === where.reference,
        );
        if (!row) return null;
        const wallet = wallets[0];
        return {
          ...row,
          card: { serialNumber: cards[0]?.serialNumber ?? SERIAL },
          wallet: wallet
            ? { ...wallet, customer: customers.find((row) => row.id === wallet.customerId) }
            : null,
        };
      },
    },
    $transaction: (fn: (client: typeof tx) => Promise<unknown>) => {
      const run = chain.then(() => fn(tx));
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };

  const service = new PlatformService(
    prisma as never,
    {
      enqueue: jest.fn(async (phone: string, type: string, message: string) => {
        sms.push({ phone, type, message });
        return { id: 'sms' };
      }),
    } as never,
    { flush: jest.fn() } as never,
    { assertCanDebit, record } as never,
    idleBooks(),
  );

  return { service, cards, wallets, customers, counts, sms, record, assertCanDebit };
}

function activeCards(cards: CardRow[], serial = SERIAL) {
  return cards.filter(
    (card) => card.serialNumber === serial && card.status === CardStatus.ACTIVE,
  );
}

describe('lost card replacement keeps the account number', () => {
  it('keeps the 12-digit card number, wallet, and balance', async () => {
    const { service, cards, wallets, counts } = boot();
    const result = await service.renewCard(SERIAL, { nfcUid: NEW_UID, amount: 0 }, agent);

    expect(result.card.cardNumber).toBe(SERIAL);
    expect(result.card.serialNumber).toBe(SERIAL);
    expect(result.card.nfcUid).toBe(NEW_UID_STORED);
    expect(result.card.status).toBe(CardStatus.ACTIVE);
    expect(result.wallet.balance).toBe(35_000);
    expect(wallets).toHaveLength(1);
    expect(wallets[0].balance).toBe(35_000);
    expect(wallets[0].id).toBe('wallet-1');
    expect(counts.customers).toBe(0);
    expect(counts.wallets).toBe(0);

    const current = activeCards(cards);
    expect(current).toHaveLength(1);
    expect(current[0].serialNumber).toBe(SERIAL);
    expect(current[0].nfcUid).toBe(NEW_UID_STORED);
    expect(current[0].walletId).toBe('wallet-1');

    const previous = cards.find((card) => card.id === 'card-old');
    expect(previous?.status).toBe(CardStatus.LOST);
    expect(previous?.nfcUid).toBe(OLD_UID);
    expect(previous?.serialNumber).toBe(SERIAL);
    expect(previous?.replacedById).toBe(current[0].id);
    expect(new Set(cards.map((card) => card.serialNumber))).toEqual(new Set([SERIAL]));
  });

  it('rejects fare payment on the lost NFC UID', async () => {
    const { service } = boot();
    await service.replaceCard(SERIAL, { nfcUid: NEW_UID });
    await expect(
      service.tap(conductor, {
        amount: 1_000,
        nfcUid: '04:A1:B2:C3:D4:55',
        serviceType: 'TRANSPORT',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts fare payment on the new NFC UID', async () => {
    const { service, wallets } = boot();
    await service.replaceCard(SERIAL, { nfcUid: NEW_UID });
    const paid = await service.tap(conductor, {
      amount: 1_000,
      nfcUid: '04B1C2D3E466',
      serviceType: 'TRANSPORT',
    });
    expect(paid.status).toBe('SUCCESS');
    expect(paid.wallet.balance).toBe(34_000);
    expect(wallets[0].id).toBe('wallet-1');
    expect(paid.card.serialNumber).toBe(SERIAL);
  });

  it('replays the same fare idempotency key without charging twice', async () => {
    const { service, wallets } = boot();
    const first = await service.tap(conductor, {
      amount: 1_000,
      nfcUid: OLD_UID,
      idempotencyKey: 'fare-retry-01',
    });
    const second = await service.tap(conductor, {
      amount: 1_000,
      nfcUid: OLD_UID,
      idempotencyKey: 'fare-retry-01',
    });
    expect(second.reference).toBe(first.reference);
    expect(second.wallet.balance).toBe(34_000);
    expect(wallets[0].balance).toBe(34_000);
  });

  it('points the old and new physical cards at the same wallet', async () => {
    const { service, cards } = boot();
    await service.renewCard(SERIAL, { nfcUid: NEW_UID }, agent);
    const walletIds = new Set(cards.map((card) => card.walletId));
    expect(walletIds).toEqual(new Set(['wallet-1']));
    expect(cards.every((card) => card.serialNumber === SERIAL)).toBe(true);
  });

  it('does not create a customer or a wallet', async () => {
    const { service, counts, customers, wallets } = boot();
    await service.renewCard(SERIAL, { nfcUid: NEW_UID }, agent);
    expect(counts.customers).toBe(0);
    expect(counts.wallets).toBe(0);
    expect(customers).toHaveLength(1);
    expect(wallets).toHaveLength(1);
  });

  it('does not generate a new 12-digit number', async () => {
    const { service, cards } = boot();
    await expect(
      service.replaceCard(SERIAL, {
        nfcUid: NEW_UID,
        serialNumber: '111111111111',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(cards).toHaveLength(1);
    expect(cards[0].serialNumber).toBe(SERIAL);
    expect(cards[0].status).toBe(CardStatus.ACTIVE);
  });

  it('still resolves the permanent card number to the same wallet', async () => {
    const { service, wallets } = boot();
    await service.renewCard(SERIAL, { nfcUid: NEW_UID }, agent);
    const lookedUp = await service.lookupCard(SERIAL);
    expect(lookedUp.card.cardNumber).toBe(SERIAL);
    expect(lookedUp.card.nfcUid).toBe(NEW_UID_STORED);
    expect(lookedUp.wallet.publicCode).toBe('999888777666');
    expect(lookedUp.wallet.balance).toBe(35_000);

    const credited = await service.topUp(agent, {
      walletAccountNumber: SERIAL,
      amount: 2_000,
    });
    expect(credited.wallet.publicCode).toBe('999888777666');
    expect(credited.wallet.balance).toBeUndefined();
    expect(credited.card.balance).toBeUndefined();
    expect(credited.previousBalance).toBeUndefined();
    expect(wallets[0].balance).toBe(37_000);
    expect(credited.card.cardNumber).toBe(SERIAL);
  });

  it('is safe to retry the same replacement', async () => {
    const { service, cards, wallets, counts, record, sms } = boot();
    await service.renewCard(SERIAL, { nfcUid: NEW_UID, amount: 5_000 }, agent);
    await service.renewCard(SERIAL, { nfcUid: NEW_UID, amount: 5_000 }, agent);

    expect(activeCards(cards)).toHaveLength(1);
    expect(wallets).toHaveLength(1);
    expect(wallets[0].balance).toBe(40_000);
    expect(counts.customers).toBe(0);
    expect(counts.wallets).toBe(0);
    expect(new Set(cards.map((card) => card.serialNumber))).toEqual(new Set([SERIAL]));
    expect(record).toHaveBeenCalledTimes(1);
    expect(sms.filter((row) => row.type === 'CARD_RENEWED')).toHaveLength(1);
  });

  it('does not change wakala float on a pure replacement', async () => {
    const { service, record, assertCanDebit, wallets } = boot();
    await service.renewCard(SERIAL, { nfcUid: NEW_UID, amount: 0 }, agent);
    expect(assertCanDebit).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(wallets[0].balance).toBe(35_000);
  });

  it('loads extra renewal cash once and does not debit float again on retry', async () => {
    const { service, record, wallets, cards } = boot();
    await service.renewCard(SERIAL, { nfcUid: NEW_UID, amount: 10_000 }, agent);
    await service.renewCard(SERIAL, { nfcUid: NEW_UID, amount: 10_000 }, agent);
    expect(wallets[0].balance).toBe(45_000);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ amount: 10_000 }),
    );
    expect(activeCards(cards)).toHaveLength(1);
  });

  it('allows only one active physical card when two replacements race', async () => {
    const { service, cards } = boot();
    const results = await Promise.allSettled([
      service.replaceCard(SERIAL, { nfcUid: '04:11:22:33:44:55' }),
      service.replaceCard(SERIAL, { nfcUid: '04:66:77:88:99:00' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictException);
    expect(activeCards(cards)).toHaveLength(1);
    expect(cards.filter((card) => card.serialNumber === SERIAL).every((card) => card.serialNumber === SERIAL)).toBe(true);
  });

  it('sends a renewal SMS to the passenger phone', async () => {
    const { service, sms } = boot();
    await service.renewCard(SERIAL, { nfcUid: NEW_UID }, agent);
    expect(sms).toEqual([
      expect.objectContaining({
        type: 'CARD_RENEWED',
        phone: '+255713000001',
      }),
    ]);
    expect(sms[0].message).toContain(SERIAL);
  });

  it('issues a new 12-digit number only for a new customer', async () => {
    const { service, counts, sms, wallets } = boot({ empty: true });
    const created = await service.issueCard(
      {
        firstName: 'Neema',
        lastName: 'Ally',
        phone: '+255713000099',
        nfcUid: '04C1D2E3F401',
        initialLoad: 0,
      },
      agent,
    );
    expect(created.card.cardNumber).toMatch(/^\d{12}$/);
    expect(created.card.cardNumber).not.toBe(SERIAL);
    expect(counts.customers).toBe(1);
    expect(counts.wallets).toBe(1);
    expect(counts.cards).toBe(1);

    const account = wallets[0]?.publicCode;
    expect(account).toBe(created.wallet.publicCode);
    expect(sms[0].message).toContain('Karibu BusPay, NEEMA ALLY');
    expect(sms[0].message).toContain(
      `Namba ya pochi yako ni ${created.wallet.publicCode}, kwa jina la NEEMA ALLY`,
    );
    expect(sms[0].message).toContain('huduma za pesa kwa simu');
    expect(sms[0].message.startsWith('BusPay')).toBe(false);
    expect(sms[0].message).not.toContain('04C1D2E3F401');
    expect(sms[0].message).not.toContain(created.card.cardNumber);
  });
});

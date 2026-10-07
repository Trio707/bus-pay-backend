import { CardStatus } from '../generated/prisma';
import { SmsService } from '../sms/sms.service';
import { idleBooks } from '../financial/idle-books';
import { PlatformService } from './platform.service';

function cardFixture() {
  return {
    id: 'card-1',
    serialNumber: 'BP1',
    nfcUid: null,
    status: CardStatus.ACTIVE,
    walletId: 'wallet-1',
    wallet: {
      id: 'wallet-1',
      balance: 1000,
      publicCode: 'W1',
      status: 'ACTIVE',
      customer: {
        id: 'cust-1',
        firstName: 'Asha',
        lastName: 'Juma',
        phone: '+255712345678',
      },
    },
  };
}

describe('card renewal SMS', () => {
  it('enqueues CARD_RENEWED inside a committed renewal with no extra amount', async () => {
    const committed: { type?: string; phone?: string; status?: string }[] = [];
    const walletUpdate = jest.fn();
    const topUpCreate = jest.fn();
    const prisma = {
      card: { findFirst: jest.fn().mockResolvedValue(cardFixture()) },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const staged: { type?: string; phone?: string; status?: string }[] = [];
        const tx = {
          card: {
            update: jest.fn().mockResolvedValue({
              id: 'card-1',
              serialNumber: 'BP1',
              nfcUid: null,
              status: CardStatus.ACTIVE,
              issuedAt: new Date(),
            }),
          },
          customer: { update: jest.fn() },
          wallet: { update: walletUpdate },
          topUp: { create: topUpCreate, findUnique: jest.fn() },
          smsOutbox: {
            create: jest.fn(async ({ data }: { data: { type: string; phone: string; status: string } }) => {
              staged.push(data);
              return { id: 'sms-1', ...data };
            }),
          },
        };
        const result = await fn(tx);
        committed.push(...staged);
        return result;
      },
    };
    const service = new PlatformService(
      prisma as never,
      new SmsService(prisma as never),
      { flush: jest.fn() } as never,
      { assertCanDebit: jest.fn(), record: jest.fn() } as never,
      idleBooks(),
    );

    await service.renewCard('BP1', { amount: 0 });

    expect(committed).toEqual([
      expect.objectContaining({
        type: 'CARD_RENEWED',
        phone: '+255712345678',
        status: 'PENDING',
      }),
    ]);
    expect(walletUpdate).not.toHaveBeenCalled();
    expect(topUpCreate).not.toHaveBeenCalled();
  });

  it('does not keep a CARD_RENEWED row when the renewal transaction rolls back', async () => {
    const committed: unknown[] = [];
    let stagedCount = 0;
    const prisma = {
      card: { findFirst: jest.fn().mockResolvedValue(cardFixture()) },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const staged: unknown[] = [];
        const tx = {
          card: {
            update: jest.fn().mockResolvedValue({
              id: 'card-1',
              serialNumber: 'BP1',
              nfcUid: null,
              status: CardStatus.ACTIVE,
              issuedAt: new Date(),
            }),
          },
          customer: { update: jest.fn() },
          wallet: { update: jest.fn() },
          topUp: { create: jest.fn(), findUnique: jest.fn() },
          smsOutbox: {
            create: jest.fn(async ({ data }: { data: unknown }) => {
              staged.push(data);
              stagedCount += 1;
              return data;
            }),
          },
        };
        await fn(tx);
        throw new Error('commit failed');
      },
    };
    const service = new PlatformService(
      prisma as never,
      new SmsService(prisma as never),
      { flush: jest.fn() } as never,
      { assertCanDebit: jest.fn(), record: jest.fn() } as never,
      idleBooks(),
    );

    await expect(service.renewCard('BP1', { amount: 0 })).rejects.toThrow(
      'commit failed',
    );
    expect(stagedCount).toBe(1);
    expect(committed).toEqual([]);
  });
});

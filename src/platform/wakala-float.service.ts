import { randomInt } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  WakalaFloatFundingChannel,
  WakalaFloatTransactionType,
} from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';

export type FloatPosting = {
  agentUserId: string;
  type: WakalaFloatTransactionType;
  /** Positive TZS magnitude. ADJUSTMENT may be signed. */
  amount: number;
  reference: string;
  reason?: string;
  fundingChannel?: WakalaFloatFundingChannel | null;
  /** Set when a verified payment-provider callback funds float later. */
  externalReference?: string;
  /**
   * Required for FLOAT_FUNDING on PAYMENT_PROVIDER.
   * A typed reference from a wakala is not verification.
   */
  verifiedProviderFunding?: boolean;
  topUpId?: string;
  withdrawalId?: string;
};

type LockedFloat = { id: string; balance: number };

@Injectable()
export class WakalaFloatService {
  constructor(private readonly prisma: PrismaService) {}

  async getBalance(agentUserId: string) {
    const row = await this.prisma.wakalaFloat.findUnique({
      where: { agentUserId },
      select: { balance: true, updatedAt: true },
    });
    return {
      agentUserId,
      balance: row?.balance ?? 0,
      currency: 'TZS',
      updatedAt: row?.updatedAt ?? null,
    };
  }

  async listTransactions(agentUserId: string, page = 1, limit = 50) {
    const take = Math.min(100, Math.max(1, limit));
    const skip = (Math.max(1, page) - 1) * take;
    const where = { agentUserId };
    const [total, transactions] = await Promise.all([
      this.prisma.wakalaFloatTransaction.count({ where }),
      this.prisma.wakalaFloatTransaction.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          type: true,
          amount: true,
          balanceBefore: true,
          balanceAfter: true,
          reference: true,
          reason: true,
          fundingChannel: true,
          externalReference: true,
          createdAt: true,
        },
      }),
    ]);
    return { page: Math.max(1, page), limit: take, total, transactions };
  }

  /**
   * Debit check under a row lock. Does not change the balance.
   * The matching record() call must run in the same database transaction.
   */
  async assertCanDebit(
    tx: Prisma.TransactionClient,
    agentUserId: string,
    amount: number,
  ) {
    if (!Number.isInteger(amount) || amount < 1) {
      throw new BadRequestException('Amount must be greater than 0');
    }
    const locked = await this.lock(tx, agentUserId);
    if (locked.balance < amount) {
      throw new BadRequestException('Insufficient float balance.');
    }
    return locked;
  }

  /**
   * Posts one immutable float movement. Repeat calls with the same
   * topUpId, withdrawalId, reference, or externalReference do not move
   * the balance again.
   */
  async record(tx: Prisma.TransactionClient, posting: FloatPosting) {
    if (
      posting.type === WakalaFloatTransactionType.FLOAT_FUNDING &&
      posting.fundingChannel === WakalaFloatFundingChannel.PAYMENT_PROVIDER &&
      posting.verifiedProviderFunding !== true
    ) {
      throw new BadRequestException(
        'Float can be funded from a payment provider only after a verified provider transaction.',
      );
    }
    const existing = await this.findExisting(tx, posting);
    if (existing) {
      return Object.assign(existing, { alreadyPosted: true });
    }

    const delta = this.delta(posting);
    const locked = await this.lock(tx, posting.agentUserId);
    const balanceBefore = locked.balance;
    const balanceAfter = balanceBefore + delta;
    if (balanceAfter < 0) {
      throw new BadRequestException('Insufficient float balance.');
    }

    const updated = await tx.wakalaFloat.updateMany({
      where: { id: locked.id, balance: balanceBefore },
      data: { balance: balanceAfter },
    });
    if (updated.count !== 1) {
      throw new ConflictException('Float balance changed. Retry the operation.');
    }

    const created = await tx.wakalaFloatTransaction.create({
      data: {
        floatId: locked.id,
        agentUserId: posting.agentUserId,
        type: posting.type,
        amount:
          posting.type === WakalaFloatTransactionType.ADJUSTMENT
            ? posting.amount
            : Math.abs(posting.amount),
        balanceBefore,
        balanceAfter,
        reference: posting.reference,
        reason: posting.reason?.trim() || null,
        fundingChannel: posting.fundingChannel ?? null,
        externalReference: posting.externalReference ?? null,
        topUpId: posting.topUpId ?? null,
        withdrawalId: posting.withdrawalId ?? null,
      },
    });
    return Object.assign(created, { alreadyPosted: false });
  }

  async nextFundingReference(tx: Prisma.TransactionClient): Promise<string> {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const reference = `FF-${day}-${String(randomInt(0, 1_000_000)).padStart(6, '0')}`;
      const taken = await tx.wakalaFloatTransaction.findUnique({
        where: { reference },
      });
      if (!taken) return reference;
    }
    throw new ConflictException('Could not generate a float funding reference');
  }

  private delta(posting: FloatPosting): number {
    if (!Number.isInteger(posting.amount)) {
      throw new BadRequestException('Amount must be a whole number of TZS');
    }
    switch (posting.type) {
      case WakalaFloatTransactionType.FLOAT_FUNDING:
      case WakalaFloatTransactionType.CONDUCTOR_WITHDRAWAL:
        if (posting.amount < 1) {
          throw new BadRequestException('Amount must be greater than 0');
        }
        return posting.amount;
      case WakalaFloatTransactionType.PASSENGER_TOPUP:
        if (posting.amount < 1) {
          throw new BadRequestException('Amount must be greater than 0');
        }
        return -posting.amount;
      case WakalaFloatTransactionType.ADJUSTMENT:
        if (posting.amount === 0) {
          throw new BadRequestException('Adjustment amount cannot be 0');
        }
        return posting.amount;
      default:
        throw new BadRequestException('Unknown float transaction type');
    }
  }

  private async findExisting(
    tx: Prisma.TransactionClient,
    posting: FloatPosting,
  ) {
    if (posting.topUpId) {
      const row = await tx.wakalaFloatTransaction.findUnique({
        where: { topUpId: posting.topUpId },
      });
      if (row) return row;
    }
    if (posting.withdrawalId) {
      const row = await tx.wakalaFloatTransaction.findUnique({
        where: { withdrawalId: posting.withdrawalId },
      });
      if (row) return row;
    }
    if (posting.externalReference) {
      const row = await tx.wakalaFloatTransaction.findUnique({
        where: { externalReference: posting.externalReference },
      });
      if (row) return row;
    }
    return tx.wakalaFloatTransaction.findUnique({
      where: { reference: posting.reference },
    });
  }

  private async lock(
    tx: Prisma.TransactionClient,
    agentUserId: string,
  ): Promise<LockedFloat> {
    await tx.wakalaFloat.upsert({
      where: { agentUserId },
      create: { agentUserId, balance: 0 },
      update: {},
    });
    const rows = await tx.$queryRaw<Array<{ id: string; balance: number }>>`
      SELECT "id", "balance"
      FROM "WakalaFloat"
      WHERE "agentUserId" = ${agentUserId}
      FOR UPDATE
    `;
    const row = rows[0];
    if (!row) {
      throw new NotFoundException('Wakala float not found');
    }
    return { id: row.id, balance: Number(row.balance) };
  }
}

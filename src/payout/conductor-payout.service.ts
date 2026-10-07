import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ConductorPayoutMethod,
  ConductorPayoutStatus,
  Prisma,
  UserRole,
  UserStatus,
  WithdrawalStatus,
  type User,
} from '../generated/prisma';
import { normalizeName, normalizePhone, personName, TZ_PHONE_PATTERN } from '../auth/identity';
import { BooksService } from '../financial/books.service';
import { lockConductorBalance } from '../platform/conductor-balance';
import { PrismaService } from '../prisma/prisma.service';
import { SmsDispatcherService } from '../sms/sms-dispatcher.service';
import { SmsService } from '../sms/sms.service';
import { payoutCompletedSms, payoutPendingSms, payoutReleasedSms } from '../sms/sms-copy';
import { maskDestination } from './payout-mask';
import {
  PAYOUT_PROVIDER,
  type PayoutProvider,
  type PayoutProviderResult,
} from './payout-provider';
import { CreateConductorPayoutDto } from './dto/create-payout.dto';

const HELD_PAYOUT_STATUSES: ConductorPayoutStatus[] = [
  ConductorPayoutStatus.PENDING,
  ConductorPayoutStatus.PROCESSING,
  ConductorPayoutStatus.COMPLETED,
];

type PayoutRow = {
  id: string;
  reference: string;
  idempotencyKey: string;
  conductorUserId: string;
  amount: number;
  method: ConductorPayoutMethod;
  provider: string;
  destination: string;
  accountName: string | null;
  status: ConductorPayoutStatus;
  providerReference: string | null;
  failureReason: string | null;
  platformFee: number;
  totalDebit: number;
  requestedAt: Date;
  processingAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  conductor?: { phone: string };
};

@Injectable()
export class ConductorPayoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsService,
    private readonly smsDispatcher: SmsDispatcherService,
    @Inject(PAYOUT_PROVIDER) private readonly provider: PayoutProvider,
    private readonly books: BooksService,
  ) {}

  async quote(amount: number) {
    if (!Number.isInteger(amount) || amount < 1) {
      throw new BadRequestException('Enter a whole TZS amount');
    }
    const quote = await this.books.quoteWithdrawal(amount);
    return {
      currency: 'TZS' as const,
      amount: quote.netAmount,
      fee: quote.fee,
      platformFee: quote.fee,
      netAmount: quote.netAmount,
      totalDebit: quote.totalDebit,
      tier: quote.tier,
    };
  }

  async request(user: User, dto: CreateConductorPayoutDto) {
    if (user.role !== UserRole.CONDUCTOR) {
      throw new ForbiddenException('Only conductors can request a payout');
    }
    if (user.status !== UserStatus.ACTIVE) {
      throw new BadRequestException('Conductor account is not active');
    }
    if (this.provider.configured === false) {
      throw new ServiceUnavailableException(
        'External payout provider is not connected. No funds were reserved.',
      );
    }

    const method = dto.method;
    const providerCode = dto.provider.trim().toUpperCase();
    this.assertProviderSupported(method, providerCode);
    const destination = this.destinationOf(method, dto);

    const existing = await this.prisma.conductorPayout.findUnique({
      where: {
        conductorUserId_idempotencyKey: {
          conductorUserId: user.id,
          idempotencyKey: dto.idempotencyKey,
        },
      },
    });
    if (existing) {
      return this.present(existing, true);
    }

    const quote = await this.books.quoteWithdrawal(dto.amount);
    const terminal = await this.prisma.terminal.findFirst({
      where: { ownerUserId: user.id, status: 'ACTIVE' },
    });
    if (!terminal) {
      throw new BadRequestException('Conductor terminal is not ready');
    }

    const created = await this.prisma.$transaction(async (tx) => {
      await lockConductorBalance(tx, user.id);
      const replay = await tx.conductorPayout.findUnique({
        where: {
          conductorUserId_idempotencyKey: {
            conductorUserId: user.id,
            idempotencyKey: dto.idempotencyKey,
          },
        },
      });
      if (replay) return { payout: replay, replay: true as const };

      const available = await this.availableBalance(tx, user.id, terminal.id);
      if (quote.totalDebit > available) {
        throw new BadRequestException(
          `Insufficient balance. Available TZS ${available}. Fee TZS ${quote.fee}. Total TZS ${quote.totalDebit}.`,
        );
      }

      const payout = await tx.conductorPayout.create({
        data: {
          reference: await this.nextReference(tx),
          idempotencyKey: dto.idempotencyKey,
          conductorUserId: user.id,
          amount: dto.amount,
          platformFee: quote.fee,
          totalDebit: quote.totalDebit,
          method: method as ConductorPayoutMethod,
          provider: providerCode,
          destination,
          accountName: dto.accountName?.trim()
            ? normalizeName(dto.accountName)
            : null,
          status: ConductorPayoutStatus.PENDING,
        },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: user.id,
          action: 'CONDUCTOR_PAYOUT_REQUESTED',
          entityType: 'ConductorPayout',
          entityId: payout.id,
          metadata: this.auditMeta(payout),
        },
      });
      return { payout, replay: false as const };
    });

    if (created.replay) {
      return this.present(created.payout, true);
    }

    let providerResult: PayoutProviderResult;
    try {
      providerResult = await this.provider.createPayout({
        payoutId: created.payout.id,
        reference: created.payout.reference,
        amount: created.payout.amount,
        method,
        provider: providerCode,
        destination,
        accountName: created.payout.accountName,
      });
    } catch {
      providerResult = { outcome: 'UNCERTAIN' };
    }

    const settled = await this.applyCreateResult(
      created.payout.id,
      user.phone,
      providerResult,
    );
    void this.smsDispatcher.flush();
    return this.present(settled, false);
  }

  async listMine(user: User) {
    if (user.role !== UserRole.CONDUCTOR) {
      throw new ForbiddenException('Only conductors can view payouts');
    }
    const rows = await this.prisma.conductorPayout.findMany({
      where: { conductorUserId: user.id },
      orderBy: { requestedAt: 'desc' },
      take: 50,
    });
    return { payouts: rows.map((row) => this.view(row)) };
  }

  async getMine(user: User, id: string) {
    const row = await this.prisma.conductorPayout.findFirst({
      where: { id, conductorUserId: user.id },
    });
    if (!row) throw new NotFoundException('Payout not found');
    return this.view(row);
  }

  async listForAdmin(page = 1, limit = 50, status?: ConductorPayoutStatus) {
    const take = Math.min(100, Math.max(1, limit));
    const skip = (Math.max(1, page) - 1) * take;
    const where = status ? { status } : {};
    const [total, rows] = await Promise.all([
      this.prisma.conductorPayout.count({ where }),
      this.prisma.conductorPayout.findMany({
        where,
        skip,
        take,
        orderBy: { requestedAt: 'desc' },
        include: {
          conductor: {
            select: { id: true, firstName: true, lastName: true, phone: true },
          },
        },
      }),
    ]);
    return {
      page: Math.max(1, page),
      limit: take,
      total,
      payouts: rows.map((row) => ({
        ...this.view(row),
        conductor: {
          id: row.conductor.id,
          name: personName(row.conductor.firstName, row.conductor.lastName),
          phone: row.conductor.phone,
        },
      })),
    };
  }

  /** Future reconciliation can read the provider without settling locally. */
  async inspectProviderStatus(providerReference: string) {
    return this.provider.getPayoutStatus(providerReference);
  }

  async handleWebhook(rawBody: Buffer | undefined, signature: unknown) {
    const secret = process.env.PAYOUT_WEBHOOK_SECRET?.trim() ?? '';
    if (!secret) {
      throw new ServiceUnavailableException('Payout webhook is not configured');
    }
    if (!rawBody?.length) {
      throw new BadRequestException('Empty payout callback');
    }
    this.assertSignature(rawBody, signature, secret);

    let body: { providerReference?: string; status?: string; failureReason?: string };
    try {
      body = JSON.parse(rawBody.toString('utf8')) as typeof body;
    } catch {
      throw new BadRequestException('Invalid payout callback');
    }
    const providerReference = body.providerReference?.trim();
    const status = body.status?.trim().toUpperCase();
    if (
      !providerReference ||
      (status !== 'COMPLETED' && status !== 'FAILED' && status !== 'REVERSED')
    ) {
      throw new BadRequestException('Invalid payout callback');
    }

    const payout = await this.prisma.conductorPayout.findUnique({
      where: { providerReference },
      include: { conductor: { select: { phone: true } } },
    });
    if (!payout) throw new NotFoundException('Payout not found');

    const nextStatus =
      status === 'COMPLETED'
        ? ConductorPayoutStatus.COMPLETED
        : status === 'REVERSED'
          ? ConductorPayoutStatus.REVERSED
          : ConductorPayoutStatus.FAILED;
    const next = await this.transition(
      payout,
      nextStatus,
      payout.conductor.phone,
      body.failureReason,
    );
    void this.smsDispatcher.flush();
    return { received: true, reference: next.reference, status: next.status };
  }

  private async applyCreateResult(
    payoutId: string,
    phone: string,
    result: PayoutProviderResult,
  ) {
    if (result.outcome === 'ACCEPTED') {
      return this.transition(
        await this.requirePayout(payoutId),
        ConductorPayoutStatus.PROCESSING,
        phone,
        undefined,
        result.providerReference,
      );
    }
    if (result.outcome === 'REJECTED') {
      return this.transition(
        await this.requirePayout(payoutId),
        ConductorPayoutStatus.FAILED,
        phone,
        result.reason,
      );
    }
    const pending = await this.requirePayout(payoutId);
    if (pending.status === ConductorPayoutStatus.PENDING) {
      await this.sms.enqueue(
        phone,
        'CONDUCTOR_PAYOUT_PENDING',
        this.pendingMessage(pending),
      );
      await this.prisma.auditLog.create({
        data: {
          actorUserId: pending.conductorUserId,
          action: 'CONDUCTOR_PAYOUT_PROCESSING',
          entityType: 'ConductorPayout',
          entityId: pending.id,
          metadata: {
            ...this.auditMeta(pending),
            note: 'Provider result uncertain. Funds stay reserved.',
          },
        },
      });
    }
    return pending;
  }

  private async transition(
    payout: PayoutRow,
    next: ConductorPayoutStatus,
    phone: string,
    failureReason?: string,
    providerReference?: string,
  ) {
    if (payout.status === next && next !== ConductorPayoutStatus.PROCESSING) {
      return payout;
    }
    if (!this.canMove(payout.status, next)) {
      return payout;
    }

    return this.prisma.$transaction(async (tx) => {
      await lockConductorBalance(tx, payout.conductorUserId);
      const current = await tx.conductorPayout.findUnique({ where: { id: payout.id } });
      if (!current || !this.canMove(current.status, next)) return current ?? payout;

      const data: Prisma.ConductorPayoutUpdateManyMutationInput = { status: next };
      if (next === ConductorPayoutStatus.PROCESSING) {
        data.processingAt = new Date();
        data.providerReference = providerReference;
      }
      if (next === ConductorPayoutStatus.COMPLETED) data.completedAt = new Date();
      if (next === ConductorPayoutStatus.FAILED || next === ConductorPayoutStatus.REVERSED) {
        data.failedAt = new Date();
        data.failureReason = (failureReason ?? 'Payout failed').slice(0, 180);
      }

      const updated = await tx.conductorPayout.updateMany({
        where: { id: payout.id, status: current.status },
        data,
      });
      if (updated.count !== 1) {
        return (await tx.conductorPayout.findUnique({ where: { id: payout.id } })) ?? payout;
      }
      const saved = await tx.conductorPayout.findUnique({ where: { id: payout.id } });
      if (!saved) return payout;
      if (next === ConductorPayoutStatus.COMPLETED) {
        await this.books.postPayoutCompleted(tx, {
          payoutId: saved.id,
          netAmount: saved.amount,
          fee: saved.platformFee ?? 0,
        });
      }
      if (next === ConductorPayoutStatus.REVERSED) {
        await this.books.reversePayout(tx, {
          payoutId: saved.id,
          netAmount: saved.amount,
          fee: saved.platformFee ?? 0,
        });
      }

      const action =
        next === ConductorPayoutStatus.COMPLETED
          ? 'CONDUCTOR_PAYOUT_COMPLETED'
          : next === ConductorPayoutStatus.FAILED
            ? 'CONDUCTOR_PAYOUT_FAILED'
            : next === ConductorPayoutStatus.REVERSED
              ? 'CONDUCTOR_PAYOUT_REVERSED'
              : 'CONDUCTOR_PAYOUT_PROCESSING';
      await tx.auditLog.create({
        data: {
          actorUserId: saved.conductorUserId,
          action,
          entityType: 'ConductorPayout',
          entityId: saved.id,
          metadata: this.auditMeta(saved),
        },
      });
      try {
        await this.sms.enqueue(phone, this.smsType(next), this.smsText(saved), tx);
      } catch {
        // The payout state is the source of truth. SMS failure must not roll it back.
      }
      return saved;
    });
  }

  private canMove(from: ConductorPayoutStatus, to: ConductorPayoutStatus) {
    if (from === to) return false;
    if (from === ConductorPayoutStatus.PENDING && to === ConductorPayoutStatus.PROCESSING) {
      return true;
    }
    if (from === ConductorPayoutStatus.PENDING && to === ConductorPayoutStatus.FAILED) {
      return true;
    }
    if (from === ConductorPayoutStatus.PROCESSING && to === ConductorPayoutStatus.COMPLETED) {
      return true;
    }
    if (from === ConductorPayoutStatus.PROCESSING && to === ConductorPayoutStatus.FAILED) {
      return true;
    }
    if (from === ConductorPayoutStatus.COMPLETED && to === ConductorPayoutStatus.REVERSED) {
      return true;
    }
    return false;
  }

  private async availableBalance(
    db: Prisma.TransactionClient | PrismaService,
    conductorUserId: string,
    terminalId: string,
  ) {
    const taps = await db.paymentTransaction.aggregate({
      where: { terminalId, status: 'SUCCESS' },
      _sum: { conductorShare: true, amount: true },
    });
    const withdrawals = await db.withdrawal.aggregate({
      where: {
        conductorUserId,
        status: {
          in: [
            WithdrawalStatus.PENDING,
            WithdrawalStatus.APPROVED,
            WithdrawalStatus.PAID,
          ],
        },
      },
      _sum: { totalDebit: true, amount: true },
    });
    const payouts = await db.conductorPayout.aggregate({
      where: { conductorUserId, status: { in: HELD_PAYOUT_STATUSES } },
      _sum: { totalDebit: true, amount: true },
    });
    const tapsShare =
      taps._sum.conductorShare == null ? (taps._sum.amount ?? 0) : taps._sum.conductorShare;
    const withdrawn =
      withdrawals._sum.totalDebit == null
        ? (withdrawals._sum.amount ?? 0)
        : withdrawals._sum.totalDebit;
    const reserved =
      payouts._sum.totalDebit == null ? (payouts._sum.amount ?? 0) : payouts._sum.totalDebit;
    const gross = tapsShare;
    const held = withdrawn + reserved;
    return Math.max(0, gross - held);
  }

  private assertProviderSupported(method: 'MOBILE_MONEY' | 'BANK', provider: string) {
    const raw =
      method === 'MOBILE_MONEY'
        ? process.env.PAYOUT_MOBILE_PROVIDERS
        : process.env.PAYOUT_BANK_PROVIDERS;
    const allowed = (raw ?? '')
      .split(',')
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean);
    if (!allowed.includes(provider)) {
      throw new BadRequestException('Provider is not supported');
    }
  }

  private destinationOf(method: 'MOBILE_MONEY' | 'BANK', dto: CreateConductorPayoutDto) {
    if (method === 'MOBILE_MONEY') {
      const phone = normalizePhone(dto.mobileNumber ?? '');
      if (!TZ_PHONE_PATTERN.test(phone)) {
        throw new BadRequestException('Use a Tanzanian number like +255712345678');
      }
      return phone;
    }
    const account = dto.accountNumber?.trim() ?? '';
    if (!/^[A-Za-z0-9-]{6,30}$/.test(account)) {
      throw new BadRequestException('Enter a valid account number');
    }
    return account;
  }

  private assertSignature(raw: Buffer, signature: unknown, secret: string) {
    const given = typeof signature === 'string' ? signature.trim() : '';
    const expected = createHmac('sha256', secret).update(raw).digest('hex');
    const left = Buffer.from(given);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      throw new ForbiddenException('Invalid payout callback signature');
    }
  }

  private async requirePayout(id: string) {
    const payout = await this.prisma.conductorPayout.findUnique({ where: { id } });
    if (!payout) throw new NotFoundException('Payout not found');
    return payout;
  }

  private async nextReference(tx: Prisma.TransactionClient) {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const reference = `PO-${day}-${String(randomInt(0, 1000000)).padStart(6, '0')}`;
      const taken = await tx.conductorPayout.findUnique({ where: { reference } });
      if (!taken) return reference;
    }
    throw new ConflictException('Could not generate a payout reference');
  }

  private present(payout: PayoutRow, replay: boolean) {
    return {
      success: true,
      replay,
      message:
        payout.status === ConductorPayoutStatus.FAILED
          ? 'Payout failed. Reserved funds were released.'
          : payout.status === ConductorPayoutStatus.COMPLETED
            ? 'Payout completed'
            : 'Payout is being processed. This is not a completed transfer.',
      ...this.view(payout),
    };
  }

  private view(payout: PayoutRow) {
    return {
      id: payout.id,
      reference: payout.reference,
      amount: payout.amount,
      method: payout.method,
      provider: payout.provider,
      destination: maskDestination(payout.method, payout.destination),
      fee: payout.platformFee ?? 0,
      totalDebit: payout.totalDebit ?? payout.amount,
      netAmount: payout.amount,
      status: payout.status,
      providerReference: payout.providerReference,
      failureReason: payout.failureReason,
      requestedAt: payout.requestedAt,
      processingAt: payout.processingAt,
      completedAt: payout.completedAt,
      failedAt: payout.failedAt,
    };
  }

  private auditMeta(payout: PayoutRow) {
    return {
      reference: payout.reference,
      amount: payout.amount,
      method: payout.method,
      provider: payout.provider,
      destination: maskDestination(payout.method, payout.destination),
      status: payout.status,
      providerReference: payout.providerReference,
    };
  }

  private smsType(status: ConductorPayoutStatus) {
    if (status === ConductorPayoutStatus.COMPLETED) return 'CONDUCTOR_PAYOUT_COMPLETED' as const;
    if (status === ConductorPayoutStatus.FAILED) return 'CONDUCTOR_PAYOUT_FAILED' as const;
    if (status === ConductorPayoutStatus.REVERSED) return 'CONDUCTOR_PAYOUT_FAILED' as const;
    return 'CONDUCTOR_PAYOUT_PENDING' as const;
  }

  private smsText(payout: PayoutRow) {
    const destination = maskDestination(payout.method, payout.destination);
    if (payout.status === ConductorPayoutStatus.COMPLETED) {
      return payoutCompletedSms(payout.amount, destination, payout.reference);
    }
    if (
      payout.status === ConductorPayoutStatus.REVERSED ||
      payout.status === ConductorPayoutStatus.FAILED
    ) {
      return payoutReleasedSms(payout.amount, payout.reference);
    }
    return this.pendingMessage(payout);
  }

  private pendingMessage(payout: PayoutRow) {
    return payoutPendingSms(
      payout.amount,
      maskDestination(payout.method, payout.destination),
      payout.reference,
    );
  }
}

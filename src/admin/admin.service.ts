import { randomInt } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import {
  AlertSeverity,
  AlertStatus,
  CardInventoryStatus,
  CardStatus,
  Prisma,
  RefundStatus,
  SettlementStatus,
  TopUpSource,
  TransactionStatus,
  UserRole,
  UserStatus,
  WakalaFloatFundingChannel,
  WakalaFloatTransactionType,
  WalletStatus,
  WithdrawalStatus,
  type User,
} from '../generated/prisma';
import { normalizeNfcUid, sameNfcUid } from '../platform/nfc-uid';
import { WakalaFloatService } from '../platform/wakala-float.service';
import { AuthorizationService } from '../auth/authorization.service';
import { normalizeEmail } from '../auth/email';
import {
  normalizeName,
  normalizeNida,
  normalizePhone,
  personName,
  phoneLookupValues,
  presentNames,
} from '../auth/identity';
import { assertNidaAvailable, withConductorNidaLock } from '../auth/nida-policy';
import { EmailService } from '../email/email.service';
import { generateTemporaryPassword } from '../auth/password-policy';
import { PrismaService } from '../prisma/prisma.service';
import { SmsDispatcherService } from '../sms/sms-dispatcher.service';
import { SmsService } from '../sms/sms.service';
import { floatFundingSms, refundSms, renewalSms } from '../sms/sms-copy';
import { queuePaidWithdrawalSms } from '../sms/withdrawal-sms';
import {
  AssignTerminalDto,
  BulkInventoryDto,
  CreateConductorDto,
  CreateSettlementDto,
  ListAlertsQueryDto,
  ListAuditLogsQueryDto,
  ListCardsQueryDto,
  ListCustomersQueryDto,
  ListInventoryQueryDto,
  ListRefundsQueryDto,
  ListSettlementsQueryDto,
  ListTopUpsQueryDto,
  ListTransactionsQueryDto,
  ListUsersQueryDto,
  ListWalletsQueryDto,
  ListWithdrawalsQueryDto,
  PaginationQueryDto,
  ReplaceCardDto,
  ReportsQueryDto,
  ReverseTransactionDto,
  UpdateCustomerStatusDto,
  UpdateSettingsDto,
  UpdateUserStatusDto,
  WithdrawalDecisionDto,
  FundWakalaFloatDto,
  CreateMasterWakalaDto,
  UpdateMasterWakalaDto,
} from './dto/admin.dto';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsService,
    private readonly floats: WakalaFloatService,
    @Optional() private readonly smsDispatcher?: SmsDispatcherService,
    @Optional() private readonly email?: EmailService,
  ) {
    this.authz = new AuthorizationService(prisma);
  }

  private readonly authz: AuthorizationService;

  async overview() {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [
      agents,
      conductors,
      activeCards,
      activeWallets,
      suspendedUsers,
      lockedUsers,
      tapAgg,
      topUpAgg,
    ] = await Promise.all([
      this.prisma.user.count({ where: { role: UserRole.AGENT } }),
      this.prisma.user.count({ where: { role: UserRole.CONDUCTOR } }),
      this.prisma.card.count({ where: { status: CardStatus.ACTIVE } }),
      this.prisma.wallet.count({ where: { status: WalletStatus.ACTIVE } }),
      this.prisma.user.count({ where: { status: UserStatus.SUSPENDED } }),
      this.prisma.user.count({
        where: { lockedUntil: { gt: new Date() } },
      }),
      this.prisma.paymentTransaction.aggregate({
        where: {
          status: TransactionStatus.SUCCESS,
          createdAt: { gte: startOfDay },
        },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.topUp.aggregate({
        where: { createdAt: { gte: startOfDay } },
        _sum: { amount: true },
        _count: true,
      }),
    ]);

    return {
      counts: {
        agents,
        conductors,
        activeCards,
        activeWallets,
        suspendedUsers,
        lockedUsers,
      },
      today: {
        tapVolume: tapAgg._sum.amount ?? 0,
        tapCount: tapAgg._count,
        topUpVolume: topUpAgg._sum.amount ?? 0,
        topUpCount: topUpAgg._count,
      },
    };
  }

  async listUsers(query: ListUsersQueryDto, actor?: User) {
    if (actor) {
      await this.authz.requireUserList(actor, query.role);
    }
    const { skip, take, page, limit } = this.pageOf(query);
    const where: Prisma.UserWhereInput = {};
    if (query.role) where.role = query.role;
    if (query.status) where.status = query.status;
    if (query.q?.trim()) {
      const q = query.q.trim();
      where.OR = [
        { username: { contains: q, mode: 'insensitive' } },
        { firstName: { contains: q, mode: 'insensitive' } },
        { lastName: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
        { email: { contains: q, mode: 'insensitive' } },
        { nida: { contains: q } },
      ];
    }

    const [total, users] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          username: true,
          firstName: true,
          lastName: true,
          phone: true,
          email: true,
          nida: true,
          tillNumber: true,
          role: true,
          status: true,
          failedLoginAttempts: true,
          lockedUntil: true,
          createdAt: true,
          updatedAt: true,
          profilePhotoKey: true,
          profilePhotoUpdatedAt: true,
          wakalaFloat: { select: { balance: true } },
        },
      }),
    ]);

    return {
      page,
      limit,
      total,
      users: users.map(({ wakalaFloat, profilePhotoKey, ...u }) =>
        presentNames({
          ...u,
          role: this.toApiRole(u.role),
          hasProfilePhoto: Boolean(profilePhotoKey),
          floatBalance:
            u.role === UserRole.AGENT ? (wakalaFloat?.balance ?? 0) : null,
        }),
      ),
    };
  }

  async getUser(id: string, actor?: User) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        username: true,
        firstName: true,
        lastName: true,
        phone: true,
        email: true,
        nida: true,
        tillNumber: true,
        role: true,
        status: true,
        failedLoginAttempts: true,
        lockedUntil: true,
        createdAt: true,
        updatedAt: true,
        terminals: {
          select: {
            id: true,
            terminalCode: true,
            status: true,
            merchant: { select: { merchantCode: true, name: true } },
          },
        },
        wakalaFloat: { select: { balance: true, updatedAt: true } },
      },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (actor) {
      await this.authz.requireUserRead(actor, user.role);
    }
    const { wakalaFloat, ...rest } = user;
    return presentNames({
      ...rest,
      role: this.toApiRole(user.role),
      floatBalance:
        user.role === UserRole.AGENT ? (wakalaFloat?.balance ?? 0) : null,
    });
  }

  async getWakalaFloat(agentUserId: string) {
    const agent = await this.requireAgent(agentUserId);
    const balance = await this.floats.getBalance(agent.id);
    return {
      agent: this.agentSummary(agent),
      ...balance,
    };
  }

  async listWakalaFloatTransactions(
    agentUserId: string,
    query: PaginationQueryDto,
  ) {
    const agent = await this.requireAgent(agentUserId);
    const { page, limit } = this.pageOf(query);
    const history = await this.floats.listTransactions(agent.id, page, limit);
    return { agent: this.agentSummary(agent), ...history };
  }

  async fundWakalaFloat(
    actor: User,
    agentUserId: string,
    dto: FundWakalaFloatDto,
  ) {
    if (actor.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only admin can fund wakala float');
    }
    if (!Number.isInteger(dto.amount) || dto.amount < 1) {
      throw new BadRequestException('Amount must be greater than 0');
    }
    const agent = await this.requireAgent(agentUserId);
    const reason = dto.reason?.trim() || 'Admin float funding';
    const requestedReference = dto.reference?.trim();

    const posted = await this.prisma.$transaction(async (tx) => {
      const reference =
        requestedReference || (await this.floats.nextFundingReference(tx));
      const row = await this.floats.record(tx, {
        agentUserId: agent.id,
        type: WakalaFloatTransactionType.FLOAT_FUNDING,
        amount: dto.amount,
        reference,
        reason,
        fundingChannel: WakalaFloatFundingChannel.ADMIN,
      });
      await tx.auditLog.create({
        data: {
          actorUserId: actor.id,
          action: 'FLOAT_FUND',
          entityType: 'WakalaFloat',
          entityId: agent.id,
          metadata: {
            amount: dto.amount,
            reference: row.reference,
            reason,
            balanceBefore: row.balanceBefore,
            balanceAfter: row.balanceAfter,
            fundingChannel: WakalaFloatFundingChannel.ADMIN,
          },
        },
      });
      return row;
    });

    if (!posted.alreadyPosted) {
      try {
        await this.sms.enqueue(
          agent.phone,
          'WAKALA_FLOAT_FUNDING',
          floatFundingSms(dto.amount, posted.balanceAfter, posted.reference),
        );
        void this.smsDispatcher?.flush();
      } catch {
        // The funding row is already committed. Delivery retries from the outbox.
      }
    }

    return {
      message: 'Wakala float funded',
      agent: this.agentSummary(agent),
      amount: dto.amount,
      reference: posted.reference,
      balanceBefore: posted.balanceBefore,
      balanceAfter: posted.balanceAfter,
      currency: 'TZS',
    };
  }

  async createConductor(actor: User, dto: CreateConductorDto) {
    const firstName = normalizeName(dto.firstName);
    const lastName = normalizeName(dto.lastName);
    const phone = normalizePhone(dto.phone);
    const nida = normalizeNida(dto.nida);

    const existingPhone = await this.prisma.user.findFirst({
      where: { phone: { in: phoneLookupValues(phone) } },
    });
    if (existingPhone) {
      throw new ConflictException('Phone number is already registered');
    }

    const passwordHash = await bcrypt.hash(dto.pin, 12);
    const user = await withConductorNidaLock(
      this.prisma,
      nida,
      async (tx, normalized) => {
        const username = await this.uniqueConductorUsername(tx);
        return tx.user.create({
          data: {
            username,
            passwordHash,
            firstName,
            lastName,
            phone,
            nida: normalized,
            role: UserRole.CONDUCTOR,
            status: UserStatus.ACTIVE,
          },
        });
      },
    );

    await this.audit(actor.id, 'USER_CREATE', 'User', user.id, {
      role: 'conductor',
      username: user.username,
    });

    return {
      message: 'Conductor created',
      username: user.username,
      role: 'conductor' as const,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      status: user.status,
    };
  }

  async updateUserStatus(
    actor: User,
    id: string,
    dto: UpdateUserStatusDto,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    await this.authz.requireStatusChange(actor, user, dto.status);
    if (user.role === UserRole.ADMIN && dto.status !== UserStatus.ACTIVE) {
      throw new BadRequestException('Cannot suspend or deactivate an admin');
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: { status: dto.status },
    });

    await this.audit(actor.id, 'USER_STATUS_UPDATE', 'User', id, {
      from: user.status,
      to: dto.status,
    });

    return {
      id: updated.id,
      username: updated.username,
      role: this.toApiRole(updated.role),
      status: updated.status,
    };
  }

  async listTerminals(query: PaginationQueryDto) {
    const { skip, take, page, limit } = this.pageOf(query);
    const [total, terminals] = await Promise.all([
      this.prisma.terminal.count(),
      this.prisma.terminal.findMany({
        skip,
        take,
        orderBy: { terminalCode: 'asc' },
        include: {
          merchant: {
            select: { id: true, merchantCode: true, name: true },
          },
          owner: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              role: true,
              status: true,
            },
          },
        },
      }),
    ]);

    return presentNames({
      page,
      limit,
      total,
      terminals: terminals.map((t) => ({
        id: t.id,
        terminalCode: t.terminalCode,
        type: t.type,
        status: t.status,
        merchant: t.merchant,
        conductor: t.owner
          ? {
              id: t.owner.id,
              username: t.owner.username,
              firstName: t.owner.firstName,
              lastName: t.owner.lastName,
              role: this.toApiRole(t.owner.role),
              status: t.owner.status,
            }
          : null,
      })),
    });
  }

  async assignTerminal(
    actor: User,
    terminalId: string,
    dto: AssignTerminalDto,
  ) {
    const terminal = await this.prisma.terminal.findUnique({
      where: { id: terminalId },
    });
    if (!terminal) {
      throw new NotFoundException('Terminal not found');
    }

    const conductor = await this.prisma.user.findUnique({
      where: { id: dto.conductorUserId },
    });
    if (!conductor || conductor.role !== UserRole.CONDUCTOR) {
      throw new BadRequestException('conductorUserId must be a conductor');
    }
    if (conductor.status !== UserStatus.ACTIVE) {
      throw new BadRequestException('Conductor must be ACTIVE');
    }

    const updated = await this.prisma.terminal.update({
      where: { id: terminalId },
      data: { ownerUserId: conductor.id },
      include: {
        merchant: { select: { merchantCode: true, name: true } },
        owner: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    await this.audit(actor.id, 'TERMINAL_ASSIGN', 'Terminal', terminalId, {
      conductorUserId: conductor.id,
      previousOwnerUserId: terminal.ownerUserId,
    });

    return presentNames({
      id: updated.id,
      terminalCode: updated.terminalCode,
      merchant: updated.merchant,
      conductor: updated.owner,
    });
  }

  async listCards(query: ListCardsQueryDto) {
    const { skip, take, page, limit } = this.pageOf(query);
    const where: Prisma.CardWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.q?.trim()) {
      const q = query.q.trim();
      where.OR = [
        { serialNumber: { contains: q, mode: 'insensitive' } },
        { nfcUid: { contains: q, mode: 'insensitive' } },
        {
          wallet: {
            customer: {
              OR: [
                { phone: { contains: q } },
                { firstName: { contains: q, mode: 'insensitive' } },
                { lastName: { contains: q, mode: 'insensitive' } },
              ],
            },
          },
        },
      ];
    }

    const [total, cards] = await Promise.all([
      this.prisma.card.count({ where }),
      this.prisma.card.findMany({
        where,
        skip,
        take,
        orderBy: { issuedAt: 'desc' },
        include: {
          replaces: {
            select: {
              nfcUid: true,
              status: true,
              serialNumber: true,
            },
          },
          wallet: {
            select: {
              id: true,
              publicCode: true,
              balance: true,
              status: true,
              customer: {
                select: {
                  firstName: true,
                  lastName: true,
                  phone: true,
                },
              },
            },
          },
        },
      }),
    ]);

    return presentNames({ page, limit, total, cards });
  }

  async getCard(serial: string) {
    const card = await this.findCardBySerial(serial);
    return presentNames(card);
  }

  async freezeCard(actor: User, serial: string) {
    const card = await this.findCardBySerial(serial);
    if (card.status === CardStatus.REPLACED) {
      throw new BadRequestException('Cannot freeze a replaced card');
    }
    const updated = await this.prisma.card.update({
      where: { id: card.id },
      data: { status: CardStatus.FROZEN },
    });
    await this.audit(actor.id, 'CARD_FREEZE', 'Card', card.id, {
      serialNumber: updated.serialNumber,
    });
    return {
      message: 'Card frozen',
      serialNumber: updated.serialNumber,
      status: updated.status,
    };
  }

  async unfreezeCard(actor: User, serial: string) {
    const card = await this.findCardBySerial(serial);
    if (card.status !== CardStatus.FROZEN) {
      throw new BadRequestException('Only frozen cards can be unfrozen');
    }
    const updated = await this.prisma.card.update({
      where: { id: card.id },
      data: { status: CardStatus.ACTIVE },
    });
    await this.audit(actor.id, 'CARD_UNFREEZE', 'Card', card.id, {
      serialNumber: updated.serialNumber,
    });
    return {
      message: 'Card unfrozen',
      serialNumber: updated.serialNumber,
      status: updated.status,
    };
  }

  async replaceCard(actor: User, oldSerial: string, dto: ReplaceCardDto) {
    const nfcUid = normalizeNfcUid(dto.nfcUid);
    if (!nfcUid) {
      throw new BadRequestException('nfcUid is required from the NFC scanner');
    }

    const oldCard = await this.findCardBySerial(oldSerial);
    const requested = dto.serialNumber?.trim().toUpperCase();
    if (requested && requested !== oldCard.serialNumber) {
      throw new BadRequestException(
        'Replacement keeps the existing card number',
      );
    }
    if (sameNfcUid(oldCard.nfcUid, nfcUid)) {
      throw new BadRequestException('Scan the new physical card');
    }

    const taken = await this.prisma.card.findFirst({
      where: { nfcUid: { in: [nfcUid, nfcUid.replace(/:/g, '')] } },
    });
    if (taken && taken.id !== oldCard.id) {
      throw new ConflictException('NFC UID is already issued');
    }

    const phone = oldCard.wallet.customer.phone;
    const serialNumber = oldCard.serialNumber;
    const replacement = await this.prisma.$transaction(async (tx) => {
      const claimable =
        oldCard.status === CardStatus.ACTIVE ||
        oldCard.status === CardStatus.FROZEN;
      if (claimable) {
        const claimed = await tx.card.updateMany({
          where: {
            id: oldCard.id,
            status: { in: [CardStatus.ACTIVE, CardStatus.FROZEN] },
          },
          data: { status: CardStatus.LOST },
        });
        if (claimed.count !== 1) {
          throw new ConflictException('Card was already replaced');
        }
      } else if (oldCard.replacedById) {
        throw new ConflictException('Card was already replaced');
      }

      const created = await tx.card.create({
        data: {
          serialNumber,
          nfcUid,
          walletId: oldCard.walletId,
          status: CardStatus.ACTIVE,
        },
      });
      await tx.card.update({
        where: { id: oldCard.id },
        data: {
          status: CardStatus.LOST,
          replacedById: created.id,
        },
      });
      await this.sms.enqueue(
        phone,
        'CARD_RENEWED',
        renewalSms(serialNumber, oldCard.wallet.balance, 0),
        tx,
      );
      return created;
    });

    await this.audit(actor.id, 'CARD_REPLACE', 'Card', oldCard.id, {
      serialNumber,
      oldNfcUid: oldCard.nfcUid,
      newNfcUid: replacement.nfcUid,
    });
    void this.smsDispatcher?.flush();

    return {
      message: 'Card replaced. The card number and wallet balance are unchanged.',
      oldCard: serialNumber,
      previousCard: {
        nfcUid: oldCard.nfcUid,
        status: CardStatus.LOST,
      },
      card: {
        serialNumber: replacement.serialNumber,
        nfcUid: replacement.nfcUid,
        status: replacement.status,
      },
      wallet: {
        publicCode: oldCard.wallet.publicCode,
        balance: oldCard.wallet.balance,
      },
    };
  }

  async listWallets(query: ListWalletsQueryDto) {
    const { skip, take, page, limit } = this.pageOf(query);
    const where: Prisma.WalletWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.q?.trim()) {
      const q = query.q.trim();
      where.OR = [
        { publicCode: { contains: q, mode: 'insensitive' } },
        {
          customer: {
            OR: [
              { phone: { contains: q } },
              { firstName: { contains: q, mode: 'insensitive' } },
              { lastName: { contains: q, mode: 'insensitive' } },
              { nida: { contains: q } },
            ],
          },
        },
      ];
    }

    const [total, wallets] = await Promise.all([
      this.prisma.wallet.count({ where }),
      this.prisma.wallet.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          customer: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              phone: true,
              status: true,
            },
          },
        },
      }),
    ]);

    return presentNames({ page, limit, total, wallets });
  }

  async getWallet(id: string) {
    const wallet = await this.prisma.wallet.findUnique({
      where: { id },
      include: {
        customer: true,
        cards: {
          select: {
            id: true,
            serialNumber: true,
            nfcUid: true,
            status: true,
            issuedAt: true,
          },
        },
      },
    });
    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }
    return presentNames(wallet);
  }

  async freezeWallet(actor: User, id: string) {
    const wallet = await this.prisma.wallet.findUnique({ where: { id } });
    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }
    const updated = await this.prisma.wallet.update({
      where: { id },
      data: { status: WalletStatus.FROZEN },
    });
    await this.audit(actor.id, 'WALLET_FREEZE', 'Wallet', id, {
      publicCode: updated.publicCode,
    });
    return {
      message: 'Wallet frozen',
      id: updated.id,
      publicCode: updated.publicCode,
      status: updated.status,
    };
  }

  async unfreezeWallet(actor: User, id: string) {
    const wallet = await this.prisma.wallet.findUnique({ where: { id } });
    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }
    if (wallet.status !== WalletStatus.FROZEN) {
      throw new BadRequestException('Only frozen wallets can be unfrozen');
    }
    const updated = await this.prisma.wallet.update({
      where: { id },
      data: { status: WalletStatus.ACTIVE },
    });
    await this.audit(actor.id, 'WALLET_UNFREEZE', 'Wallet', id, {
      publicCode: updated.publicCode,
    });
    return {
      message: 'Wallet unfrozen',
      id: updated.id,
      publicCode: updated.publicCode,
      status: updated.status,
    };
  }

  async listTransactions(query: ListTransactionsQueryDto) {
    const { skip, take, page, limit } = this.pageOf(query);
    const where: Prisma.PaymentTransactionWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.terminalId) where.terminalId = query.terminalId;
    const range = this.dateRange(query.from, query.to);
    if (range) where.createdAt = range;
    if (query.q?.trim()) {
      const q = query.q.trim();
      where.OR = [
        { reference: { contains: q, mode: 'insensitive' } },
        { card: { serialNumber: { contains: q, mode: 'insensitive' } } },
        {
          wallet: {
            customer: {
              OR: [
                { firstName: { contains: q, mode: 'insensitive' } },
                { lastName: { contains: q, mode: 'insensitive' } },
                { phone: { contains: q } },
              ],
            },
          },
        },
      ];
    }

    const [total, transactions] = await Promise.all([
      this.prisma.paymentTransaction.count({ where }),
      this.prisma.paymentTransaction.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          card: { select: { serialNumber: true } },
          wallet: {
            select: {
              publicCode: true,
              customer: {
                select: { firstName: true, lastName: true, phone: true },
              },
            },
          },
          merchant: { select: { merchantCode: true, name: true } },
          terminal: { select: { id: true, terminalCode: true } },
        },
      }),
    ]);

    return {
      page,
      limit,
      total,
      transactions: transactions.map((t) => ({
        id: t.id,
        reference: t.reference,
        amount: t.amount,
        currency: t.currency,
        serviceType: t.serviceType,
        status: t.status,
        createdAt: t.createdAt,
        card: t.card.serialNumber,
        wallet: t.wallet.publicCode,
        passenger: personName(
          t.wallet.customer.firstName,
          t.wallet.customer.lastName,
        ),
        phone: t.wallet.customer.phone,
        merchant: t.merchant,
        terminal: t.terminal,
      })),
    };
  }

  async listTopUps(query: ListTopUpsQueryDto) {
    const { skip, take, page, limit } = this.pageOf(query);
    const where: Prisma.TopUpWhereInput = {};
    if (query.agentUserId) where.agentUserId = query.agentUserId;
    const range = this.dateRange(query.from, query.to);
    if (range) where.createdAt = range;
    if (query.q?.trim()) {
      const q = query.q.trim();
      where.OR = [
        { reference: { contains: q, mode: 'insensitive' } },
        { wallet: { publicCode: { contains: q, mode: 'insensitive' } } },
        { card: { serialNumber: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const [total, topUps] = await Promise.all([
      this.prisma.topUp.count({ where }),
      this.prisma.topUp.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          wallet: { select: { publicCode: true } },
          card: { select: { serialNumber: true } },
          agent: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      }),
    ]);

    return presentNames({ page, limit, total, topUps });
  }

  async listAuditLogs(query: ListAuditLogsQueryDto) {
    const { skip, take, page, limit } = this.pageOf(query);
    const where: Prisma.AuditLogWhereInput = {};
    if (query.actorUserId) where.actorUserId = query.actorUserId;
    if (query.action?.trim()) {
      where.action = {
        equals: query.action.trim(),
        mode: 'insensitive',
      };
    }
    const range = this.dateRange(query.from, query.to);
    if (range) where.createdAt = range;

    const [total, logs] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          actor: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              role: true,
            },
          },
        },
      }),
    ]);

    return presentNames({
      page,
      limit,
      total,
      logs: logs.map((log) => ({
        id: log.id,
        action: log.action,
        entityType: log.entityType,
        entityId: log.entityId,
        metadata: log.metadata,
        createdAt: log.createdAt,
        actor: {
          ...log.actor,
          role: this.toApiRole(log.actor.role),
        },
      })),
    });
  }

  async health() {
    const started = Date.now();
    let database: Record<string, unknown>;
    try {
      const [row] = await this.prisma.$queryRaw<
        Array<{ database: string; db_user: string; schema: string }>
      >`
        SELECT
          current_database() AS database,
          current_user AS db_user,
          current_schema() AS schema
      `;
      database = {
        status: 'up',
        database: row.database,
        schema: row.schema,
        user: row.db_user,
        responseTimeMs: Date.now() - started,
      };
    } catch {
      database = {
        status: 'down',
        responseTimeMs: Date.now() - started,
      };
    }

    const [smsPending, smsFailed] = await Promise.all([
      this.prisma.smsOutbox.count({ where: { status: 'PENDING' } }),
      this.prisma.smsOutbox.count({ where: { status: 'FAILED' } }),
    ]);

    return {
      status: database.status === 'up' ? 'ok' : 'degraded',
      database,
      smsOutbox: {
        pending: smsPending,
        failed: smsFailed,
      },
    };
  }

  async writeAudit(
    actorUserId: string,
    action: string,
    entityType: string,
    entityId?: string | null,
    metadata?: Prisma.InputJsonValue,
  ) {
    return this.audit(actorUserId, action, entityType, entityId, metadata);
  }

  async listCustomers(query: ListCustomersQueryDto) {
    const { skip, take, page, limit } = this.pageOf(query);
    const where: Prisma.CustomerWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.q?.trim()) {
      const q = query.q.trim();
      where.OR = [
        { firstName: { contains: q, mode: 'insensitive' } },
        { lastName: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
        { nida: { contains: q } },
        { email: { contains: q, mode: 'insensitive' } },
      ];
    }

    const [total, customers] = await Promise.all([
      this.prisma.customer.count({ where }),
      this.prisma.customer.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          wallet: {
            select: {
              id: true,
              publicCode: true,
              balance: true,
              status: true,
            },
          },
        },
      }),
    ]);

    return presentNames({ page, limit, total, customers });
  }

  async getCustomer(id: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      include: {
        wallet: {
          include: {
            cards: {
              select: {
                id: true,
                serialNumber: true,
                nfcUid: true,
                status: true,
                issuedAt: true,
              },
            },
          },
        },
      },
    });
    if (!customer) {
      throw new NotFoundException('Customer not found');
    }
    return presentNames(customer);
  }

  async updateCustomerStatus(
    actor: User,
    id: string,
    dto: UpdateCustomerStatusDto,
  ) {
    const customer = await this.prisma.customer.findUnique({ where: { id } });
    if (!customer) {
      throw new NotFoundException('Customer not found');
    }

    const updated = await this.prisma.customer.update({
      where: { id },
      data: { status: dto.status },
    });

    await this.audit(actor.id, 'CUSTOMER_STATUS_UPDATE', 'Customer', id, {
      from: customer.status,
      to: dto.status,
    });

    return presentNames({
      id: updated.id,
      firstName: updated.firstName,
      lastName: updated.lastName,
      phone: updated.phone,
      status: updated.status,
    });
  }

  async listWithdrawals(query: ListWithdrawalsQueryDto) {
    const { skip, take, page, limit } = this.pageOf(query);
    const where: Prisma.WithdrawalWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.q?.trim()) {
      const q = query.q.trim();
      where.OR = [
        { reference: { contains: q, mode: 'insensitive' } },
        {
          agent: {
            OR: [
              { username: { contains: q, mode: 'insensitive' } },
              { firstName: { contains: q, mode: 'insensitive' } },
              { lastName: { contains: q, mode: 'insensitive' } },
              { phone: { contains: q } },
            ],
          },
        },
      ];
    }

    const [total, withdrawals] = await Promise.all([
      this.prisma.withdrawal.count({ where }),
      this.prisma.withdrawal.findMany({
        where,
        skip,
        take,
        orderBy: { requestedAt: 'desc' },
        include: {
          agent: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              phone: true,
            },
          },
          processedBy: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      }),
    ]);

    return { page, limit, total, withdrawals };
  }

  async approveWithdrawal(
    actor: User,
    id: string,
    dto: WithdrawalDecisionDto,
  ) {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { id },
    });
    if (!withdrawal) {
      throw new NotFoundException('Withdrawal not found');
    }
    if (withdrawal.status !== WithdrawalStatus.PENDING) {
      throw new BadRequestException('Only PENDING withdrawals can be approved');
    }

    const updated = await this.prisma.withdrawal.update({
      where: { id },
      data: {
        status: WithdrawalStatus.APPROVED,
        notes: dto.notes?.trim() || withdrawal.notes,
        processedById: actor.id,
        processedAt: new Date(),
      },
    });

    await this.audit(actor.id, 'WITHDRAWAL_APPROVE', 'Withdrawal', id, {
      reference: updated.reference,
      amount: updated.amount,
    });

    return updated;
  }

  async rejectWithdrawal(
    actor: User,
    id: string,
    dto: WithdrawalDecisionDto,
  ) {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { id },
    });
    if (!withdrawal) {
      throw new NotFoundException('Withdrawal not found');
    }
    if (withdrawal.status !== WithdrawalStatus.PENDING) {
      throw new BadRequestException('Only PENDING withdrawals can be rejected');
    }

    const updated = await this.prisma.withdrawal.update({
      where: { id },
      data: {
        status: WithdrawalStatus.REJECTED,
        notes: dto.notes?.trim() || withdrawal.notes,
        processedById: actor.id,
        processedAt: new Date(),
      },
    });

    await this.audit(actor.id, 'WITHDRAWAL_REJECT', 'Withdrawal', id, {
      reference: updated.reference,
      amount: updated.amount,
    });

    return updated;
  }

  async markWithdrawalPaid(actor: User, id: string) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const withdrawal = await tx.withdrawal.findUnique({
        where: { id },
      });
      if (!withdrawal) {
        throw new NotFoundException('Withdrawal not found');
      }
      if (withdrawal.status !== WithdrawalStatus.APPROVED) {
        throw new BadRequestException(
          'Only APPROVED withdrawals can be marked paid',
        );
      }

      const next = await tx.withdrawal.update({
        where: { id },
        data: {
          status: WithdrawalStatus.PAID,
          processedById: actor.id,
          processedAt: new Date(),
        },
      });

      const posted = next.conductorUserId
        ? await this.floats.record(tx, {
            agentUserId: next.agentUserId,
            type: WakalaFloatTransactionType.CONDUCTOR_WITHDRAWAL,
            amount: next.amount,
            reference: next.reference,
            reason: 'Conductor withdrawal marked paid',
            withdrawalId: next.id,
          })
        : null;

      await tx.auditLog.create({
        data: {
          actorUserId: actor.id,
          action: 'WITHDRAWAL_PAID',
          entityType: 'Withdrawal',
          entityId: id,
          metadata: {
            reference: next.reference,
            amount: next.amount,
            floatCredited: Boolean(next.conductorUserId),
          },
        },
      });

      return { next, posted };
    });

    if (
      updated.posted &&
      !updated.posted.alreadyPosted &&
      updated.next.conductorUserId
    ) {
      const [conductor, wakala] = await Promise.all([
        this.prisma.user.findUnique({
          where: { id: updated.next.conductorUserId },
        }),
        this.prisma.user.findUnique({
          where: { id: updated.next.agentUserId },
        }),
      ]);
      if (conductor && wakala) {
        try {
          await queuePaidWithdrawalSms(this.sms, {
            amount: updated.next.amount,
            fee: updated.next.platformFee,
            reference: updated.next.reference,
            conductorPhone: conductor.phone,
            wakalaPhone: wakala.phone,
            floatBalance: updated.posted.balanceAfter,
          });
          void this.smsDispatcher?.flush();
        } catch {
          // The paid withdrawal is already committed.
        }
      }
    }

    return updated.next;
  }

  async listRefunds(query: ListRefundsQueryDto) {
    const { skip, take, page, limit } = this.pageOf(query);
    const where: Prisma.RefundWhereInput = {};
    const range = this.dateRange(query.from, query.to);
    if (range) where.createdAt = range;
    if (query.q?.trim()) {
      const q = query.q.trim();
      where.OR = [
        { reference: { contains: q, mode: 'insensitive' } },
        {
          transaction: {
            reference: { contains: q, mode: 'insensitive' },
          },
        },
      ];
    }

    const [total, refunds] = await Promise.all([
      this.prisma.refund.count({ where }),
      this.prisma.refund.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          transaction: {
            select: {
              id: true,
              reference: true,
              amount: true,
              status: true,
            },
          },
          actor: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      }),
    ]);

    return { page, limit, total, refunds };
  }

  async reverseTransaction(
    actor: User,
    id: string,
    dto: ReverseTransactionDto,
  ) {
    const tx = await this.prisma.paymentTransaction.findUnique({
      where: { id },
      include: {
        refund: true,
        wallet: { include: { customer: true } },
      },
    });
    if (!tx) {
      throw new NotFoundException('Transaction not found');
    }
    if (tx.status === TransactionStatus.REVERSED || tx.refund) {
      throw new BadRequestException('Transaction is already reversed');
    }
    if (tx.status !== TransactionStatus.SUCCESS) {
      throw new BadRequestException('Only SUCCESS transactions can be reversed');
    }

    const result = await this.prisma.$transaction(async (db) => {
      const wallet = await db.wallet.findUnique({
        where: { id: tx.walletId },
        include: { customer: true },
      });
      if (!wallet) {
        throw new NotFoundException('Wallet not found');
      }

      const previousBalance = wallet.balance;
      const newBalance = previousBalance + tx.amount;

      await db.wallet.update({
        where: { id: wallet.id },
        data: { balance: newBalance },
      });

      await db.paymentTransaction.update({
        where: { id: tx.id },
        data: { status: TransactionStatus.REVERSED },
      });

      const topUpRef = await this.uniqueReference('ADJ', async (reference) => {
        const taken = await db.topUp.findUnique({ where: { reference } });
        return !!taken;
      });

      const topUp = await db.topUp.create({
        data: {
          reference: topUpRef,
          walletId: wallet.id,
          cardId: tx.cardId,
          agentUserId: actor.id,
          amount: tx.amount,
          previousBalance,
          newBalance,
          source: TopUpSource.ADMIN_ADJUST,
        },
      });

      const refundRef = await this.uniqueReference('RF', async (reference) => {
        const taken = await db.refund.findUnique({ where: { reference } });
        return !!taken;
      });

      const refund = await db.refund.create({
        data: {
          reference: refundRef,
          transactionId: tx.id,
          amount: tx.amount,
          reason: dto.reason?.trim() || undefined,
          actorUserId: actor.id,
          status: RefundStatus.COMPLETED,
        },
      });

      await this.sms.enqueue(
        wallet.customer.phone,
        'WALLET_REFUND',
        refundSms(tx.amount, newBalance, tx.reference),
        db,
      );

      return { topUp, refund, previousBalance, newBalance };
    });

    await this.audit(actor.id, 'TRANSACTION_REVERSE', 'PaymentTransaction', id, {
      amount: tx.amount,
      refundId: result.refund.id,
      topUpId: result.topUp.id,
      reason: dto.reason ?? null,
    });

    return {
      message: 'Transaction reversed',
      transactionId: id,
      refund: result.refund,
      topUp: result.topUp,
      wallet: {
        previousBalance: result.previousBalance,
        newBalance: result.newBalance,
      },
    };
  }

  async listSettlements(query: ListSettlementsQueryDto) {
    const { skip, take, page, limit } = this.pageOf(query);
    const where: Prisma.SettlementWhereInput = {};
    if (query.status?.trim()) {
      const status = query.status.trim().toUpperCase();
      if (
        status === SettlementStatus.DRAFT ||
        status === SettlementStatus.FINALIZED ||
        status === SettlementStatus.PAID
      ) {
        where.status = status;
      }
    }

    const [total, settlements] = await Promise.all([
      this.prisma.settlement.count({ where }),
      this.prisma.settlement.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          lines: {
            include: {
              merchant: {
                select: { merchantCode: true, name: true },
              },
            },
          },
          paidBy: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      }),
    ]);

    return { page, limit, total, settlements };
  }

  async createSettlement(actor: User, dto: CreateSettlementDto) {
    const periodStart = new Date(dto.periodStart);
    const periodEnd = new Date(dto.periodEnd);
    if (Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime())) {
      throw new BadRequestException('Invalid periodStart or periodEnd');
    }
    if (periodEnd < periodStart) {
      throw new BadRequestException('periodEnd must be on or after periodStart');
    }

    const feeBps = dto.feeBps ?? 0;
    const grouped = await this.prisma.paymentTransaction.groupBy({
      by: ['merchantId'],
      where: {
        status: TransactionStatus.SUCCESS,
        createdAt: { gte: periodStart, lte: periodEnd },
      },
      _sum: { amount: true },
      _count: true,
    });

    if (grouped.length === 0) {
      throw new BadRequestException(
        'No SUCCESS transactions found in the given period',
      );
    }

    const merchantIds = grouped.map((g) => g.merchantId);
    const merchants = await this.prisma.merchant.findMany({
      where: { id: { in: merchantIds } },
      select: { id: true, settlementAccount: true },
    });
    const merchantMap = new Map(merchants.map((m) => [m.id, m]));

    const lines = grouped.map((g) => {
      const grossAmount = g._sum.amount ?? 0;
      const feeAmount = Math.floor((grossAmount * feeBps) / 10_000);
      const netAmount = grossAmount - feeAmount;
      return {
        merchantId: g.merchantId,
        grossAmount,
        feeAmount,
        netAmount,
        settlementAccount: merchantMap.get(g.merchantId)?.settlementAccount ?? null,
      };
    });

    const grossAmount = lines.reduce((sum, l) => sum + l.grossAmount, 0);
    const feeAmount = lines.reduce((sum, l) => sum + l.feeAmount, 0);
    const netAmount = lines.reduce((sum, l) => sum + l.netAmount, 0);

    const reference = await this.uniqueReference('ST', async (ref) => {
      const taken = await this.prisma.settlement.findUnique({
        where: { reference: ref },
      });
      return !!taken;
    });

    const settlement = await this.prisma.settlement.create({
      data: {
        reference,
        periodStart,
        periodEnd,
        status: SettlementStatus.DRAFT,
        grossAmount,
        feeAmount,
        netAmount,
        lines: { create: lines },
      },
      include: {
        lines: {
          include: {
            merchant: { select: { merchantCode: true, name: true } },
          },
        },
      },
    });

    await this.audit(actor.id, 'SETTLEMENT_CREATE', 'Settlement', settlement.id, {
      reference: settlement.reference,
      feeBps,
      grossAmount,
      netAmount,
      lineCount: lines.length,
    });

    return settlement;
  }

  async finalizeSettlement(actor: User, id: string) {
    const settlement = await this.prisma.settlement.findUnique({
      where: { id },
    });
    if (!settlement) {
      throw new NotFoundException('Settlement not found');
    }
    if (settlement.status !== SettlementStatus.DRAFT) {
      throw new BadRequestException('Only DRAFT settlements can be finalized');
    }

    const updated = await this.prisma.settlement.update({
      where: { id },
      data: {
        status: SettlementStatus.FINALIZED,
        finalizedAt: new Date(),
      },
    });

    await this.audit(actor.id, 'SETTLEMENT_FINALIZE', 'Settlement', id, {
      reference: updated.reference,
    });

    return updated;
  }

  async markSettlementPaid(actor: User, id: string) {
    const settlement = await this.prisma.settlement.findUnique({
      where: { id },
    });
    if (!settlement) {
      throw new NotFoundException('Settlement not found');
    }
    if (settlement.status !== SettlementStatus.FINALIZED) {
      throw new BadRequestException('Only FINALIZED settlements can be marked paid');
    }

    const updated = await this.prisma.settlement.update({
      where: { id },
      data: {
        status: SettlementStatus.PAID,
        paidAt: new Date(),
        paidById: actor.id,
      },
    });

    await this.audit(actor.id, 'SETTLEMENT_PAID', 'Settlement', id, {
      reference: updated.reference,
    });

    return updated;
  }

  async listInventory(query: ListInventoryQueryDto) {
    const { skip, take, page, limit } = this.pageOf(query);
    const where: Prisma.CardInventoryWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.q?.trim()) {
      const q = query.q.trim();
      where.OR = [
        { serialNumber: { contains: q, mode: 'insensitive' } },
        { nfcUid: { contains: q, mode: 'insensitive' } },
      ];
    }

    const [total, items] = await Promise.all([
      this.prisma.cardInventory.count({ where }),
      this.prisma.cardInventory.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return { page, limit, total, items };
  }

  async addInventory(actor: User, dto: BulkInventoryDto) {
    if (!dto.items?.length) {
      throw new BadRequestException('items must not be empty');
    }

    const results = [];
    for (const item of dto.items) {
      const serialNumber = item.serialNumber.trim().toUpperCase();
      const nfcUid = item.nfcUid?.replace(/\s+/g, '').toUpperCase() || null;
      const upserted = await this.prisma.cardInventory.upsert({
        where: { serialNumber },
        create: {
          serialNumber,
          nfcUid: nfcUid ?? undefined,
          status: CardInventoryStatus.IN_STOCK,
        },
        update: {
          status: CardInventoryStatus.IN_STOCK,
          ...(nfcUid ? { nfcUid } : {}),
        },
      });
      results.push(upserted);
    }

    await this.audit(actor.id, 'CARD_INVENTORY_ADD', 'CardInventory', null, {
      count: results.length,
      serials: results.map((r) => r.serialNumber),
    });

    return { count: results.length, items: results };
  }

  async reportsSummary(query: ReportsQueryDto) {
    const range = this.dateRange(query.from, query.to);
    const tapWhere: Prisma.PaymentTransactionWhereInput = {
      status: TransactionStatus.SUCCESS,
    };
    const topUpWhere: Prisma.TopUpWhereInput = {};
    if (range) {
      tapWhere.createdAt = range;
      topUpWhere.createdAt = range;
    }

    const [tapAgg, topUpAgg, byMerchantRaw, byAgentRaw] = await Promise.all([
      this.prisma.paymentTransaction.aggregate({
        where: tapWhere,
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.topUp.aggregate({
        where: topUpWhere,
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.paymentTransaction.groupBy({
        by: ['merchantId'],
        where: tapWhere,
        _sum: { amount: true },
        _count: true,
        orderBy: { _sum: { amount: 'desc' } },
      }),
      this.prisma.topUp.groupBy({
        by: ['agentUserId'],
        where: {
          ...topUpWhere,
          agentUserId: { not: null },
        },
        _sum: { amount: true },
        _count: true,
        orderBy: { _sum: { amount: 'desc' } },
      }),
    ]);

    const merchantIds = byMerchantRaw.map((m) => m.merchantId);
    const agentIds = byAgentRaw
      .map((a) => a.agentUserId)
      .filter((id): id is string => !!id);

    const [merchants, agents] = await Promise.all([
      merchantIds.length
        ? this.prisma.merchant.findMany({
            where: { id: { in: merchantIds } },
            select: { id: true, merchantCode: true, name: true },
          })
        : Promise.resolve([]),
      agentIds.length
        ? this.prisma.user.findMany({
            where: { id: { in: agentIds } },
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
            },
          })
        : Promise.resolve([]),
    ]);

    const merchantMap = new Map(merchants.map((m) => [m.id, m]));
    const agentMap = new Map(agents.map((a) => [a.id, a]));

    return {
      taps: {
        count: tapAgg._count,
        volume: tapAgg._sum.amount ?? 0,
      },
      topUps: {
        count: topUpAgg._count,
        volume: topUpAgg._sum.amount ?? 0,
      },
      byMerchant: byMerchantRaw.map((row) => {
        const merchant = merchantMap.get(row.merchantId);
        return {
          merchantCode: merchant?.merchantCode ?? row.merchantId,
          name: merchant?.name ?? 'Unknown',
          volume: row._sum.amount ?? 0,
          count: row._count,
        };
      }),
      byAgentTopUps: byAgentRaw.map((row) => {
        const agent = row.agentUserId
          ? agentMap.get(row.agentUserId)
          : undefined;
        return {
          agentUserId: row.agentUserId,
          username: agent?.username ?? null,
          name: agent ? personName(agent.firstName, agent.lastName) : null,
          volume: row._sum.amount ?? 0,
          count: row._count,
        };
      }),
    };
  }

  async listAlerts(query: ListAlertsQueryDto) {
    const { skip, take, page, limit } = this.pageOf(query);
    const where: Prisma.AlertWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.type?.trim()) {
      where.type = { equals: query.type.trim(), mode: 'insensitive' };
    }

    const [total, alerts] = await Promise.all([
      this.prisma.alert.count({ where }),
      this.prisma.alert.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return { page, limit, total, alerts };
  }

  async acknowledgeAlert(actor: User, id: string) {
    const alert = await this.prisma.alert.findUnique({ where: { id } });
    if (!alert) {
      throw new NotFoundException('Alert not found');
    }
    if (alert.status !== AlertStatus.OPEN) {
      throw new BadRequestException('Only OPEN alerts can be acknowledged');
    }

    const updated = await this.prisma.alert.update({
      where: { id },
      data: {
        status: AlertStatus.ACKED,
        ackedAt: new Date(),
      },
    });

    await this.audit(actor.id, 'ALERT_ACK', 'Alert', id, {
      type: updated.type,
    });

    return updated;
  }

  async syncAlerts() {
    const created: Array<{ type: string; id: string }> = [];

    const [smsFailed, lockedUsers, openSmsFailed, openLockedUsers] =
      await Promise.all([
        this.prisma.smsOutbox.count({ where: { status: 'FAILED' } }),
        this.prisma.user.count({
          where: { lockedUntil: { gt: new Date() } },
        }),
        this.prisma.alert.findFirst({
          where: { type: 'SMS_FAILED', status: AlertStatus.OPEN },
        }),
        this.prisma.alert.findFirst({
          where: { type: 'LOCKED_USERS', status: AlertStatus.OPEN },
        }),
      ]);

    if (smsFailed > 0 && !openSmsFailed) {
      const alert = await this.prisma.alert.create({
        data: {
          type: 'SMS_FAILED',
          severity: AlertSeverity.WARNING,
          message: `${smsFailed} SMS message(s) in FAILED status`,
          entityType: 'SmsOutbox',
          status: AlertStatus.OPEN,
        },
      });
      created.push({ type: alert.type, id: alert.id });
    }

    if (lockedUsers > 0 && !openLockedUsers) {
      const alert = await this.prisma.alert.create({
        data: {
          type: 'LOCKED_USERS',
          severity: AlertSeverity.WARNING,
          message: `${lockedUsers} user(s) currently locked`,
          entityType: 'User',
          status: AlertStatus.OPEN,
        },
      });
      created.push({ type: alert.type, id: alert.id });
    }

    return {
      smsFailed,
      lockedUsers,
      created,
    };
  }

  async unlockUser(actor: User, id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    await this.audit(actor.id, 'USER_UNLOCK', 'User', id, {
      username: updated.username,
      previousFailedLoginAttempts: user.failedLoginAttempts,
      previousLockedUntil: user.lockedUntil,
    });

    return {
      id: updated.id,
      username: updated.username,
      role: this.toApiRole(updated.role),
      failedLoginAttempts: updated.failedLoginAttempts,
      lockedUntil: updated.lockedUntil,
    };
  }

  async getSettings() {
    const keys = [
      'defaultFare',
      'lockoutMinutes',
      'smsEnabled',
      'settlementFeeBps',
    ] as const;
    const defaults: Record<(typeof keys)[number], string> = {
      defaultFare: '650',
      lockoutMinutes: '15',
      smsEnabled: 'true',
      settlementFeeBps: '0',
    };

    const rows = await this.prisma.systemSetting.findMany({
      where: { key: { in: [...keys] } },
    });
    const map = new Map(rows.map((r) => [r.key, r.value]));

    const settings: Record<string, string> = {};
    for (const key of keys) {
      settings[key] = map.get(key) ?? defaults[key];
    }
    return settings;
  }

  async updateSettings(actor: User, dto: UpdateSettingsDto) {
    const entries: Array<[string, string]> = [];
    if (dto.defaultFare !== undefined) {
      entries.push(['defaultFare', dto.defaultFare]);
    }
    if (dto.lockoutMinutes !== undefined) {
      entries.push(['lockoutMinutes', dto.lockoutMinutes]);
    }
    if (dto.smsEnabled !== undefined) {
      entries.push(['smsEnabled', dto.smsEnabled]);
    }
    if (dto.settlementFeeBps !== undefined) {
      entries.push(['settlementFeeBps', dto.settlementFeeBps]);
    }

    if (entries.length === 0) {
      throw new BadRequestException('No settings provided');
    }

    for (const [key, value] of entries) {
      await this.prisma.systemSetting.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      });
    }

    await this.audit(actor.id, 'SETTINGS_UPDATE', 'SystemSetting', null, {
      keys: entries.map(([k]) => k),
    });

    return this.getSettings();
  }

  private async uniqueReference(
    prefix: string,
    isTaken: (reference: string) => Promise<boolean>,
  ): Promise<string> {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const reference = `${prefix}-${day}-${String(randomInt(0, 1_000_000)).padStart(6, '0')}`;
      if (!(await isTaken(reference))) {
        return reference;
      }
    }
    throw new ConflictException(
      `Could not generate a unique ${prefix} reference`,
    );
  }

  private async audit(
    actorUserId: string,
    action: string,
    entityType: string,
    entityId?: string | null,
    metadata?: Prisma.InputJsonValue,
  ) {
    await this.prisma.auditLog.create({
      data: {
        actorUserId,
        action,
        entityType,
        entityId: entityId ?? undefined,
        metadata: metadata ?? undefined,
      },
    });
  }

  private async findCardBySerial(serial: string) {
    const serialNumber = serial.trim().toUpperCase();
    const include = {
      replaces: {
        select: {
          nfcUid: true,
          status: true,
          serialNumber: true,
        },
      },
      wallet: {
        include: {
          customer: {
            select: {
              firstName: true,
              lastName: true,
              phone: true,
              status: true,
            },
          },
        },
      },
    } as const;
    const live = await this.prisma.card.findFirst({
      where: {
        serialNumber,
        status: { in: [CardStatus.ACTIVE, CardStatus.FROZEN] },
      },
      include,
      orderBy: { issuedAt: 'desc' },
    });
    const card =
      live ??
      (await this.prisma.card.findFirst({
        where: { serialNumber },
        include,
        orderBy: { issuedAt: 'desc' },
      }));
    if (!card) {
      throw new NotFoundException('Card not found');
    }
    return card;
  }

  private pageOf(query: PaginationQueryDto) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 50));
    return { page, limit, skip: (page - 1) * limit, take: limit };
  }

  private dateRange(from?: string, to?: string) {
    if (!from && !to) return undefined;
    const range: Prisma.DateTimeFilter = {};
    if (from) {
      const start = new Date(from);
      if (Number.isNaN(start.getTime())) {
        throw new BadRequestException('Invalid from date');
      }
      range.gte = start;
    }
    if (to) {
      const end = new Date(to);
      if (Number.isNaN(end.getTime())) {
        throw new BadRequestException('Invalid to date');
      }
      range.lte = end;
    }
    return range;
  }

  async listMasterWakala(actor: User) {
    this.requireAdmin(actor);
    const users = await this.prisma.user.findMany({
      where: { role: UserRole.MASTER_AGENT },
      orderBy: { createdAt: 'desc' },
      include: { permissions: { select: { permissionCode: true } } },
    });
    return {
      users: users.map((user) => this.masterView(user)),
    };
  }

  async getMasterWakala(actor: User, id: string) {
    this.requireAdmin(actor);
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { permissions: { select: { permissionCode: true } } },
    });
    if (!user || user.role !== UserRole.MASTER_AGENT) {
      throw new NotFoundException('Master Wakala not found');
    }
    return this.masterView(user);
  }

  async createMasterWakala(actor: User, dto: CreateMasterWakalaDto) {
    this.requireAdmin(actor);
    this.authz.assertRoleChange(actor, 'new-master', UserRole.MASTER_AGENT);
    const permissions = this.authz.assertAssignable(dto.permissions ?? []);
    const firstName = normalizeName(dto.firstName);
    const lastName = normalizeName(dto.lastName);
    const phone = normalizePhone(dto.phone);
    const nida = normalizeNida(dto.nida);
    const email = normalizeEmail(dto.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('Use a valid email');
    }

    const existingPhone = await this.prisma.user.findFirst({
      where: { phone: { in: phoneLookupValues(phone) } },
    });
    if (existingPhone) {
      throw new ConflictException('Phone number is already registered');
    }
    await assertNidaAvailable(this.prisma, nida, UserRole.MASTER_AGENT);
    const existingEmail = await this.prisma.user.findFirst({
      where: {
        role: { in: [UserRole.ADMIN, UserRole.MASTER_AGENT] },
        email: { equals: email, mode: 'insensitive' },
      },
    });
    if (existingEmail) {
      throw new ConflictException('Email is already registered');
    }

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await bcrypt.hash(temporaryPassword, 12);
    const username = await this.uniqueStaffUsername(UserRole.MASTER_AGENT);
    const user = await this.prisma.user.create({
      data: {
        username,
        passwordHash,
        firstName,
        lastName,
        phone,
        nida,
        email,
        role: UserRole.MASTER_AGENT,
        mustChangePassword: true,
        permissions: {
          create: permissions.map((permissionCode) => ({ permissionCode })),
        },
      },
      include: { permissions: { select: { permissionCode: true } } },
    });

    await this.audit(actor.id, 'MASTER_AGENT_CREATED', 'User', user.id, {
      targetUserId: user.id,
      username: user.username,
      onboarding: 'PENDING_EMAIL',
    });
    for (const code of permissions) {
      await this.audit(actor.id, 'MASTER_AGENT_PERMISSION_GRANTED', 'User', user.id, {
        targetUserId: user.id,
        permission: code,
      });
    }

    const delivered = await this.deliverMasterCredentials(
      actor.id,
      user,
      temporaryPassword,
      'MASTER_AGENT_EMAIL_SENT',
    );
    return {
      ...this.masterView({
        ...user,
        credentialEmailSentAt: delivered.sentAt,
      }),
      emailSent: delivered.emailSent,
      message: delivered.emailSent
        ? 'Master Wakala account created and onboarding email sent.'
        : 'Master Wakala account could not be fully onboarded because the onboarding email could not be sent.',
    };
  }

  async resendMasterCredentials(actor: User, id: string) {
    this.requireAdmin(actor);
    const current = await this.requireMasterRecord(id);
    if (!current.email) {
      throw new BadRequestException('Master Wakala has no email address');
    }
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await bcrypt.hash(temporaryPassword, 12);
    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        passwordHash,
        mustChangePassword: true,
        credentialEmailSentAt: null,
        sessionVersion: { increment: 1 },
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
      include: { permissions: { select: { permissionCode: true } } },
    });
    const delivered = await this.deliverMasterCredentials(
      actor.id,
      updated,
      temporaryPassword,
      'MASTER_AGENT_CREDENTIALS_RESENT',
    );
    return {
      ...this.masterView({
        ...updated,
        credentialEmailSentAt: delivered.sentAt,
      }),
      emailSent: delivered.emailSent,
      message: delivered.emailSent
        ? 'Onboarding email sent.'
        : 'Master Wakala account could not be fully onboarded because the onboarding email could not be sent.',
    };
  }

  async sendTestEmail(actor: User, to: string) {
    this.requireAdmin(actor);
    if (!this.email) {
      throw new ServiceUnavailableException('Email is not configured');
    }
    const result = await this.email.sendTest(normalizeEmail(to));
    return {
      sent: true,
      provider: result.provider,
      providerMessageId: result.providerMessageId,
    };
  }

  private async deliverMasterCredentials(
    actorUserId: string,
    user: {
      id: string;
      email: string | null;
      firstName: string;
      lastName: string;
      sessionVersion: number;
    },
    temporaryPassword: string,
    successAction: string,
  ): Promise<{ emailSent: boolean; sentAt: Date | null }> {
    if (!user.email || !this.email) {
      await this.audit(actorUserId, 'MASTER_AGENT_EMAIL_FAILED', 'User', user.id, {
        targetUserId: user.id,
        provider: 'resend',
      });
      return { emailSent: false, sentAt: null };
    }
    try {
      const result = await this.email.sendMasterWakalaCredentials({
        to: user.email,
        fullName: personName(user.firstName, user.lastName),
        temporaryPassword,
        idempotencyKey: `master-wakala-${user.id}-${user.sessionVersion}`,
      });
      const sentAt = new Date();
      await this.prisma.user.update({
        where: { id: user.id },
        data: { credentialEmailSentAt: sentAt },
      });
      await this.audit(actorUserId, successAction, 'User', user.id, {
        targetUserId: user.id,
        provider: result.provider,
        providerMessageId: result.providerMessageId,
      });
      return { emailSent: true, sentAt };
    } catch {
      await this.audit(actorUserId, 'MASTER_AGENT_EMAIL_FAILED', 'User', user.id, {
        targetUserId: user.id,
        provider: 'resend',
      });
      return { emailSent: false, sentAt: null };
    }
  }

  async updateMasterWakala(actor: User, id: string, dto: UpdateMasterWakalaDto) {
    this.requireAdmin(actor);
    if ('role' in dto) {
      throw new ForbiddenException('Role cannot be changed here');
    }
    await this.requireMasterRecord(id);
    const data: Prisma.UserUpdateInput = {};
    if (dto.firstName) data.firstName = normalizeName(dto.firstName);
    if (dto.lastName) data.lastName = normalizeName(dto.lastName);
    if (dto.phone) {
      const phone = normalizePhone(dto.phone);
      const taken = await this.prisma.user.findFirst({
        where: { phone: { in: phoneLookupValues(phone) }, NOT: { id } },
      });
      if (taken) throw new ConflictException('Phone number is already registered');
      data.phone = phone;
    }
    if (dto.email) {
      const email = normalizeEmail(dto.email);
      const taken = await this.prisma.user.findFirst({
        where: {
          id: { not: id },
          role: { in: [UserRole.ADMIN, UserRole.MASTER_AGENT] },
          email: { equals: email, mode: 'insensitive' },
        },
      });
      if (taken) throw new ConflictException('Email is already registered');
      data.email = email;
    }
    const updated = await this.prisma.user.update({
      where: { id },
      data,
      include: { permissions: { select: { permissionCode: true } } },
    });
    await this.audit(actor.id, 'MASTER_AGENT_UPDATED', 'User', id, {
      targetUserId: id,
      fields: Object.keys(data),
    });
    return this.masterView(updated);
  }

  async setMasterPermissions(actor: User, id: string, codes: string[]) {
    this.authz.assertCanManageMasterPermissions(actor, id);
    const next = this.authz.assertAssignable(codes);
    await this.requireMasterRecord(id);
    const current = await this.prisma.userPermission.findMany({
      where: { userId: id },
      select: { permissionCode: true },
    });
    const currentCodes = new Set(current.map((row) => row.permissionCode));
    const nextCodes = new Set<string>(next);
    const granted = next.filter((code) => !currentCodes.has(code));
    const revoked = [...currentCodes].filter((code) => !nextCodes.has(code));

    await this.prisma.$transaction(async (tx) => {
      if (revoked.length) {
        await tx.userPermission.deleteMany({
          where: { userId: id, permissionCode: { in: revoked } },
        });
      }
      if (granted.length) {
        await tx.userPermission.createMany({
          data: granted.map((permissionCode) => ({ userId: id, permissionCode })),
        });
      }
      for (const code of granted) {
        await tx.auditLog.create({
          data: {
            actorUserId: actor.id,
            action: 'MASTER_AGENT_PERMISSION_GRANTED',
            entityType: 'User',
            entityId: id,
            metadata: { targetUserId: id, permission: code },
          },
        });
      }
      for (const code of revoked) {
        await tx.auditLog.create({
          data: {
            actorUserId: actor.id,
            action: 'MASTER_AGENT_PERMISSION_REVOKED',
            entityType: 'User',
            entityId: id,
            metadata: { targetUserId: id, permission: code },
          },
        });
      }
    });

    return { id, permissions: next };
  }

  async blockMasterWakala(actor: User, id: string) {
    return this.setMasterStatus(actor, id, UserStatus.SUSPENDED, 'MASTER_AGENT_BLOCKED');
  }

  async unblockMasterWakala(actor: User, id: string) {
    return this.setMasterStatus(actor, id, UserStatus.ACTIVE, 'MASTER_AGENT_UNBLOCKED');
  }

  async deactivateMasterWakala(actor: User, id: string) {
    return this.setMasterStatus(
      actor,
      id,
      UserStatus.INACTIVE,
      'MASTER_AGENT_DEACTIVATED',
    );
  }

  private requireAdmin(actor: User) {
    if (actor.role !== UserRole.ADMIN) {
      throw new ForbiddenException();
    }
  }

  private async requireMasterRecord(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user || user.role !== UserRole.MASTER_AGENT) {
      throw new NotFoundException('Master Wakala not found');
    }
    return user;
  }

  private async setMasterStatus(
    actor: User,
    id: string,
    status: UserStatus,
    action: string,
  ) {
    this.requireAdmin(actor);
    if (actor.id === id) {
      throw new ForbiddenException('You cannot change your own account');
    }
    const user = await this.requireMasterRecord(id);
    const updated = await this.prisma.user.update({
      where: { id },
      data: { status, sessionVersion: { increment: 1 } },
      include: { permissions: { select: { permissionCode: true } } },
    });
    await this.audit(actor.id, action, 'User', id, {
      targetUserId: id,
      from: user.status,
      to: status,
    });
    return this.masterView(updated);
  }

  private masterView(user: {
    id: string;
    username: string;
    firstName: string;
    lastName: string;
    phone: string;
    email: string | null;
    status: UserStatus;
    createdAt: Date;
    credentialEmailSentAt?: Date | null;
    permissions?: { permissionCode: string }[];
  }) {
    return presentNames({
      id: user.id,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      email: user.email,
      role: 'master_agent' as const,
      status: user.status,
      createdAt: user.createdAt,
      permissions: (user.permissions ?? []).map((row) => row.permissionCode),
      onboarding: user.credentialEmailSentAt ? ('EMAIL_SENT' as const) : ('PENDING_EMAIL' as const),
    });
  }

  private async uniqueStaffUsername(role: UserRole): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = String(randomInt(100000, 1000000));
      const username =
        role === UserRole.MASTER_AGENT
          ? `Bp-m${code}lead`
          : `Bp-a${code}agent`;
      const taken = await this.prisma.user.findFirst({
        where: { username: { equals: username, mode: 'insensitive' } },
      });
      if (!taken) return username;
    }
    throw new ConflictException('Could not generate a unique username');
  }

  private toApiRole(
    role: UserRole,
  ): 'admin' | 'agent' | 'conductor' | 'master_agent' {
    if (role === UserRole.ADMIN) return 'admin';
    if (role === UserRole.MASTER_AGENT) return 'master_agent';
    if (role === UserRole.AGENT) return 'agent';
    return 'conductor';
  }

  private async requireAgent(id: string) {
    const agent = await this.prisma.user.findUnique({ where: { id } });
    if (!agent || agent.role !== UserRole.AGENT) {
      throw new NotFoundException('Wakala not found');
    }
    return agent;
  }

  private agentSummary(agent: {
    id: string;
    firstName: string;
    lastName: string;
    tillNumber: string | null;
    phone: string;
  }) {
    return {
      id: agent.id,
      name: personName(agent.firstName, agent.lastName),
      tillNumber: agent.tillNumber,
      phone: agent.phone,
    };
  }

  private async uniqueConductorUsername(
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = String(randomInt(100000, 1000000));
      const username = `Bp-c${code}bus`;
      const taken = await db.user.findFirst({
        where: { username: { equals: username, mode: 'insensitive' } },
      });
      if (!taken) return username;
    }
    throw new ConflictException('Could not generate a unique username');
  }
}

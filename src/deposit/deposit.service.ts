import { randomInt } from 'node:crypto'
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import {
  CardStatus,
  TopUpSource,
  UserStatus,
  WalletDepositStatus,
  WalletStatus,
  type Prisma,
} from '../generated/prisma'
import { personName, phoneLookupValues } from '../auth/identity'
import { BooksService } from '../financial/books.service'
import { maskMobile } from '../payout/payout-mask'
import { PrismaService } from '../prisma/prisma.service'
import { topUpSms } from '../sms/sms-copy'
import { SmsService } from '../sms/sms.service'
import type { VerifiedDepositCallback } from './deposit.types'

const OPEN_STATUSES = new Set<WalletDepositStatus>([
  WalletDepositStatus.PENDING,
  WalletDepositStatus.PROCESSING,
  WalletDepositStatus.UNKNOWN,
])

type DepositRow = {
  id: string
  reference: string
  idempotencyKey: string
  walletId: string
  walletPublicCode: string
  customerId: string
  amount: number
  mobileMoneyNetwork: string
  provider: string
  status: WalletDepositStatus
  providerReference: string
  customerPhone: string
  failureReason: string | null
  topUpId: string | null
  requestedAt: Date
  processingAt: Date | null
  completedAt: Date | null
  failedAt: Date | null
  reversedAt: Date | null
  createdAt: Date
}

@Injectable()
export class DepositService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly books: BooksService,
    private readonly sms: SmsService,
  ) {}

  /**
   * Credit path. Callers must authenticate the callback before this runs.
   * The same provider reference credits the wallet once.
   */
  async applyVerifiedCallback(input: VerifiedDepositCallback) {
    this.assertCallback(input)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.prisma.$transaction((tx) => this.applyInTransaction(tx, input))
      } catch (error) {
        if (attempt === 0 && isUniqueConflict(error)) continue
        throw error
      }
    }
    throw new ConflictException('Deposit could not be applied')
  }

  async listForAdmin(page = 1, limit = 50, status?: WalletDepositStatus) {
    const take = Math.min(Math.max(limit, 1), 100)
    const skip = (Math.max(page, 1) - 1) * take
    const where = status ? { status } : {}
    const [total, rows] = await Promise.all([
      this.prisma.walletDeposit.count({ where }),
      this.prisma.walletDeposit.findMany({
        where,
        orderBy: { requestedAt: 'desc' },
        skip,
        take,
        include: depositInclude,
      }),
    ])
    const after = await this.balancesAfter(rows.map((row) => row.topUpId))
    return {
      page: Math.max(page, 1),
      limit: take,
      total,
      selcomConnected: false,
      liveMoney: false,
      deposits: rows.map((row) => this.adminView(row, after.get(row.topUpId ?? ''))),
    }
  }

  async getForAdmin(id: string) {
    const row = await this.prisma.walletDeposit.findUnique({
      where: { id },
      include: depositInclude,
    })
    if (!row) throw new NotFoundException('Deposit not found')
    const after = await this.balancesAfter([row.topUpId])
    return {
      selcomConnected: false,
      liveMoney: false,
      deposit: this.adminView(row, after.get(row.topUpId ?? '')),
    }
  }

  private async applyInTransaction(
    tx: Prisma.TransactionClient,
    input: VerifiedDepositCallback,
  ) {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended('buspay:wallet-deposit:' || ${input.providerReference}, 0::bigint))
    `
    const existing = await tx.walletDeposit.findUnique({
      where: { providerReference: input.providerReference },
    })
    if (existing) return this.applyToExisting(tx, existing, input)
    if (input.status === 'REVERSED') {
      throw new NotFoundException('Invalid provider reference')
    }
    const wallet = await this.findWallet(tx, input.walletAccount)
    this.assertPhone(wallet.customer.phone, input.customerPhone)
    if (input.status !== 'COMPLETED') {
      const row = await tx.walletDeposit.create({
        data: this.draft(input, wallet, statusOf(input.status)),
      })
      return this.result(tx, row, false)
    }
    return this.creditNew(tx, input, wallet)
  }

  private async applyToExisting(
    tx: Prisma.TransactionClient,
    existing: DepositRow,
    input: VerifiedDepositCallback,
  ) {
    if (
      existing.amount !== input.amount ||
      existing.walletPublicCode.toLowerCase() !== input.walletAccount.trim().toLowerCase()
    ) {
      throw new BadRequestException('Callback does not match the original deposit')
    }
    const wallet = await this.findWallet(tx, existing.walletPublicCode)
    this.assertPhone(wallet.customer.phone, input.customerPhone)

    if (existing.status === WalletDepositStatus.COMPLETED && input.status === 'COMPLETED') {
      return this.result(tx, existing, true)
    }
    if (existing.status === WalletDepositStatus.COMPLETED && input.status === 'REVERSED') {
      return this.reverse(tx, existing)
    }
    if (existing.status === WalletDepositStatus.REVERSED && input.status === 'REVERSED') {
      return this.result(tx, existing, true)
    }
    if (OPEN_STATUSES.has(existing.status) && input.status === 'COMPLETED') {
      return this.creditExisting(tx, existing, wallet)
    }
    if (
      existing.status === WalletDepositStatus.COMPLETED ||
      existing.status === WalletDepositStatus.REVERSED ||
      existing.status === WalletDepositStatus.FAILED
    ) {
      return this.result(tx, existing, true)
    }
    const updated = await tx.walletDeposit.update({
      where: { id: existing.id },
      data: {
        status: statusOf(input.status),
        failureReason: input.failureReason ?? existing.failureReason,
        failedAt: input.status === 'FAILED' ? new Date() : existing.failedAt,
        processingAt: input.status === 'PROCESSING' ? new Date() : existing.processingAt,
      },
    })
    return this.result(tx, updated, false)
  }

  private async creditNew(
    tx: Prisma.TransactionClient,
    input: VerifiedDepositCallback,
    wallet: WalletTarget,
  ) {
    await this.lockWallet(tx, wallet.id)
    const next = await tx.wallet.update({
      where: { id: wallet.id },
      data: { balance: { increment: input.amount } },
    })
    const card = await this.activeCard(tx, wallet.id)
    const topUp = await tx.topUp.create({
      data: {
        reference: await this.nextReference(tx, 'TU'),
        walletId: wallet.id,
        cardId: card?.id,
        amount: input.amount,
        previousBalance: next.balance - input.amount,
        newBalance: next.balance,
        source: TopUpSource.MOBILE_MONEY,
      },
    })
    const row = await tx.walletDeposit.create({
      data: {
        ...this.draft(input, wallet, WalletDepositStatus.COMPLETED),
        topUpId: topUp.id,
        completedAt: new Date(),
      },
    })
    await this.books.postMobileDeposit(tx, { depositId: row.id, amount: input.amount })
    await this.sms.enqueue(
      wallet.customer.phone,
      'TOP_UP',
      fundingSms(input.amount, next.balance, topUp.reference),
      tx,
    )
    return this.result(tx, row, false)
  }

  private async creditExisting(
    tx: Prisma.TransactionClient,
    existing: DepositRow,
    wallet: WalletTarget,
  ) {
    await this.lockWallet(tx, wallet.id)
    const next = await tx.wallet.update({
      where: { id: wallet.id },
      data: { balance: { increment: existing.amount } },
    })
    const card = await this.activeCard(tx, wallet.id)
    const topUp = await tx.topUp.create({
      data: {
        reference: await this.nextReference(tx, 'TU'),
        walletId: wallet.id,
        cardId: card?.id,
        amount: existing.amount,
        previousBalance: next.balance - existing.amount,
        newBalance: next.balance,
        source: TopUpSource.MOBILE_MONEY,
      },
    })
    const row = await tx.walletDeposit.update({
      where: { id: existing.id },
      data: {
        status: WalletDepositStatus.COMPLETED,
        topUpId: topUp.id,
        completedAt: new Date(),
        failureReason: null,
      },
    })
    await this.books.postMobileDeposit(tx, { depositId: row.id, amount: existing.amount })
    await this.sms.enqueue(
      wallet.customer.phone,
      'TOP_UP',
      fundingSms(existing.amount, next.balance, topUp.reference),
      tx,
    )
    return this.result(tx, row, false)
  }

  private async reverse(tx: Prisma.TransactionClient, existing: DepositRow) {
    await this.lockWallet(tx, existing.walletId)
    const current = await tx.wallet.findUnique({ where: { id: existing.walletId } })
    if (!current || current.balance < existing.amount) {
      throw new BadRequestException('Wallet balance is not enough to reverse this deposit')
    }
    await tx.wallet.update({
      where: { id: existing.walletId },
      data: { balance: { decrement: existing.amount } },
    })
    await this.books.reverseMobileDeposit(tx, {
      depositId: existing.id,
      amount: existing.amount,
    })
    const row = await tx.walletDeposit.update({
      where: { id: existing.id },
      data: { status: WalletDepositStatus.REVERSED, reversedAt: new Date() },
    })
    return this.result(tx, row, false)
  }

  private draft(
    input: VerifiedDepositCallback,
    wallet: WalletTarget,
    status: WalletDepositStatus,
  ) {
    const now = new Date()
    return {
      reference: `DP-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${String(randomInt(0, 1000000)).padStart(6, '0')}`,
      idempotencyKey: input.providerReference,
      walletId: wallet.id,
      walletPublicCode: wallet.publicCode,
      customerId: wallet.customerId,
      amount: input.amount,
      mobileMoneyNetwork: input.network,
      provider: input.provider,
      status,
      providerReference: input.providerReference,
      customerPhone: wallet.customer.phone,
      failureReason: input.failureReason ?? null,
      processingAt: status === WalletDepositStatus.PROCESSING ? now : null,
      failedAt: status === WalletDepositStatus.FAILED ? now : null,
    }
  }

  private async result(tx: Prisma.TransactionClient, row: DepositRow, replay: boolean) {
    const wallet = await tx.wallet.findUnique({ where: { id: row.walletId } })
    return {
      received: true,
      replay,
      id: row.id,
      reference: row.reference,
      status: row.status,
      providerReference: row.providerReference,
      amount: row.amount,
      network: row.mobileMoneyNetwork,
      wallet: {
        id: row.walletId,
        publicCode: row.walletPublicCode,
        balance: wallet?.balance ?? 0,
      },
    }
  }

  private adminView(row: DepositWithWallet, balanceAfterPayment?: number) {
    const active = row.wallet.cards.find((card) => card.status === CardStatus.ACTIVE)
    return {
      id: row.id,
      reference: row.reference,
      idempotencyKey: row.idempotencyKey,
      walletId: row.walletId,
      walletAccount: row.walletPublicCode,
      passenger: personName(row.wallet.customer.firstName, row.wallet.customer.lastName),
      phone: maskMobile(row.customerPhone),
      cardSerial: active?.serialNumber ?? null,
      channel: 'MOBILE_MONEY' as const,
      source: 'USSD_OPERATOR_PAYMENT' as const,
      amount: row.amount,
      network: row.mobileMoneyNetwork,
      provider: row.provider,
      providerReference: row.providerReference,
      status: row.status,
      createdAt: row.createdAt,
      requestedAt: row.requestedAt,
      completedAt: row.completedAt,
      failedAt: row.failedAt,
      reversedAt: row.reversedAt,
      balanceAfterPayment: balanceAfterPayment ?? null,
      walletBalance: row.wallet.balance,
      topUpId: row.topUpId,
    }
  }

  private async balancesAfter(topUpIds: Array<string | null>) {
    const ids = topUpIds.filter((id): id is string => Boolean(id))
    if (!ids.length) return new Map<string, number>()
    const rows = await this.prisma.topUp.findMany({
      where: { id: { in: ids } },
      select: { id: true, newBalance: true },
    })
    return new Map(rows.map((row) => [row.id, row.newBalance]))
  }

  private assertCallback(input: VerifiedDepositCallback) {
    if (!input.providerReference.trim() || input.providerReference.length > 80) {
      throw new BadRequestException('Invalid provider reference')
    }
    if (!Number.isInteger(input.amount) || input.amount < 1 || input.amount > 50_000_000) {
      throw new BadRequestException('Amount must be a positive whole number of TZS')
    }
    if (!input.walletAccount.trim()) {
      throw new BadRequestException('Wallet account is required')
    }
  }

  private assertPhone(stored: string, given?: string) {
    if (!given?.trim()) return
    const allowed = new Set(phoneLookupValues(stored))
    const matches = phoneLookupValues(given).some(
      (value) => allowed.has(value) || value === stored,
    )
    if (!matches) throw new BadRequestException('Phone does not match this wallet')
  }

  private async findWallet(tx: Prisma.TransactionClient, account: string) {
    const wallet = await tx.wallet.findFirst({
      where: { publicCode: { equals: account.trim(), mode: 'insensitive' } },
      include: { customer: true },
    })
    if (!wallet) throw new NotFoundException('Wallet account was not found')
    if (wallet.status !== WalletStatus.ACTIVE) {
      throw new BadRequestException('Wallet is not active')
    }
    if (wallet.customer.status !== UserStatus.ACTIVE) {
      throw new BadRequestException('Passenger account is not active')
    }
    return wallet
  }

  private async lockWallet(tx: Prisma.TransactionClient, walletId: string) {
    await tx.$queryRaw`SELECT "id" FROM "Wallet" WHERE "id" = ${walletId} FOR UPDATE`
  }

  private activeCard(tx: Prisma.TransactionClient, walletId: string) {
    return tx.card.findFirst({
      where: { walletId, status: CardStatus.ACTIVE },
    })
  }

  private async nextReference(tx: Prisma.TransactionClient, prefix: 'TU' | 'DP') {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const reference = `${prefix}-${day}-${String(randomInt(0, 1000000)).padStart(6, '0')}`
      const taken =
        prefix === 'TU'
          ? await tx.topUp.findUnique({ where: { reference } })
          : await tx.walletDeposit.findUnique({ where: { reference } })
      if (!taken) return reference
    }
    throw new ConflictException('Could not generate a deposit reference')
  }
}

const depositInclude = {
  wallet: {
    include: {
      customer: true,
      cards: true,
    },
  },
} satisfies Prisma.WalletDepositInclude

type DepositWithWallet = Prisma.WalletDepositGetPayload<{ include: typeof depositInclude }>

type WalletTarget = {
  id: string
  publicCode: string
  customerId: string
  customer: { phone: string }
}

function statusOf(status: VerifiedDepositCallback['status']): WalletDepositStatus {
  return WalletDepositStatus[status]
}

function fundingSms(amount: number, balance: number, reference: string) {
  return `${topUpSms(amount, balance, reference)} Asante kwa kutumia BusPay.`
}

function isUniqueConflict(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

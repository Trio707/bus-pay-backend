import { randomInt } from 'node:crypto'
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import {
  CompanyFinanceStatus,
  FinancialAccountType,
  type Prisma,
} from '../generated/prisma'
import {
  ACCOUNTS,
  COMPANY_EXPENSE_ACCOUNTS,
  CUSTOMER_FUND_CODES,
} from './accounts'
import { LedgerService, type LedgerLine, type LedgerPosting } from './ledger.service'
import { PrismaService } from '../prisma/prisma.service'

export const COMPANY_OPENING_SETTING = 'financial.company-opening-cash'
export const COMPANY_OPENING_REFERENCE = 'COMPANY-OPENING-CASH-20261007'
export const COMPANY_PROVIDER_STATUS = 'NOT_CONNECTED' as const

const CUSTOMER_OR_LOCKED = new Set<string>([
  ...CUSTOMER_FUND_CODES,
  ACCOUNTS.OPENING_BALANCE_EQUITY,
  ACCOUNTS.OPERATING,
  ACCOUNTS.WAKALA_COMMISSION_EXPENSE,
  ACCOUNTS.FARE_REVENUE,
  ACCOUNTS.WITHDRAWAL_FEE_REVENUE,
  ACCOUNTS.OTHER_REVENUE,
])

const CHART: Array<{ code: string; name: string; type: FinancialAccountType; allowNegative: boolean }> = [
  { code: ACCOUNTS.COMPANY_CASH, name: 'COMPANY_CASH', type: FinancialAccountType.ASSET, allowNegative: false },
  { code: ACCOUNTS.COMPANY_CASH_HELD, name: 'COMPANY_CASH_HELD', type: FinancialAccountType.ASSET, allowNegative: false },
  { code: ACCOUNTS.INFRASTRUCTURE_EXPENSE, name: 'INFRASTRUCTURE_EXPENSE', type: FinancialAccountType.EXPENSE, allowNegative: false },
  { code: ACCOUNTS.SALARIES_EXPENSE, name: 'SALARIES_EXPENSE', type: FinancialAccountType.EXPENSE, allowNegative: false },
  { code: ACCOUNTS.OFFICE_EXPENSE, name: 'OFFICE_EXPENSE', type: FinancialAccountType.EXPENSE, allowNegative: false },
  { code: ACCOUNTS.PROFESSIONAL_SERVICES_EXPENSE, name: 'PROFESSIONAL_SERVICES_EXPENSE', type: FinancialAccountType.EXPENSE, allowNegative: false },
  { code: ACCOUNTS.OTHER_OPERATING_EXPENSE, name: 'OTHER_OPERATING_EXPENSE', type: FinancialAccountType.EXPENSE, allowNegative: false },
  { code: ACCOUNTS.OWNER_DISTRIBUTIONS, name: 'OWNER_SHAREHOLDER_DISTRIBUTIONS', type: FinancialAccountType.EQUITY, allowNegative: true },
  { code: ACCOUNTS.RETAINED_EARNINGS, name: 'RETAINED_EARNINGS', type: FinancialAccountType.EQUITY, allowNegative: true },
  { code: ACCOUNTS.SHAREHOLDER_CAPITAL, name: 'SHAREHOLDER_CAPITAL', type: FinancialAccountType.EQUITY, allowNegative: false },
]

type BankRow = {
  id: string
  name: string
  accountType: string
  bankName: string | null
  accountNumberMasked: string
  ledgerAccountCode: string
  status: string
}

type FinanceRow = {
  id: string
  type: string
  amount: number
  status: CompanyFinanceStatus
  description: string
  reference: string
  idempotencyKey: string
  bankAccountId: string | null
  destinationBankAccountId: string | null
  destinationMasked: string | null
  expenseAccountCode: string | null
  requestedByUserId: string
  approvedByUserId: string | null
  providerReference: string | null
  failureReason: string | null
  createdAt: Date
  approvedAt: Date | null
  completedAt: Date | null
}

@Injectable()
export class CompanyFinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {}

  async position() {
    const accounts = await this.prisma.financialAccount.findMany()
    const banks = await this.prisma.companyBankAccount.findMany()
    return this.compute(accounts, banks)
  }

  async customerFunds() {
    const accounts = await this.prisma.financialAccount.findMany({
      where: { accountCode: { in: [...CUSTOMER_FUND_CODES] } },
    })
    const balance = (code: string) => accounts.find((row) => row.accountCode === code)?.balance ?? 0
    return {
      passengerWallets: balance(ACCOUNTS.PASSENGER_WALLETS),
      conductorEarnings: balance(ACCOUNTS.CONDUCTOR_EARNINGS),
      wakalaFloat: balance(ACCOUNTS.WAKALA_FLOAT),
      providerClearing: balance(ACCOUNTS.SELCOM_CLEARING),
      currency: 'TZS',
      note: 'These balances are not BusPay company profit.',
    }
  }

  async cashReconciliation() {
    const [accounts, banks, transactions] = await Promise.all([
      this.prisma.financialAccount.findMany(),
      this.prisma.companyBankAccount.findMany(),
      this.prisma.companyFinanceTransaction.findMany(),
    ])
    const ledgerBalance = spendableBalance(accounts, banks)
    const operationalBalance = operationalCash(transactions)
    const difference = ledgerBalance - operationalBalance
    return [
      {
        account: 'COMPANY_CASH',
        accountCode: ACCOUNTS.COMPANY_CASH,
        operationalBalance,
        ledgerBalance,
        difference,
        status: difference === 0 ? 'MATCH' : 'MISMATCH',
      },
    ]
  }

  listBanks() {
    return this.prisma.companyBankAccount.findMany({ orderBy: { createdAt: 'asc' } })
  }

  listTransactions() {
    return this.prisma.companyFinanceTransaction.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { bankAccount: true, destinationBankAccount: true },
    })
  }

  async createBank(
    actorUserId: string,
    input: { name: string; bankName?: string; accountNumber: string; accountType?: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx)
      await this.ensureChart(tx)
      const masked = maskAccountNumber(input.accountNumber)
      const code = await this.nextBankCode(tx)
      await tx.financialAccount.create({
        data: {
          accountCode: code,
          name: input.name.trim(),
          type: FinancialAccountType.ASSET,
          allowNegative: false,
          currency: 'TZS',
          status: 'ACTIVE',
        },
      })
      const bank = await tx.companyBankAccount.create({
        data: {
          name: input.name.trim(),
          accountType: input.accountType?.trim() || 'BANK',
          bankName: input.bankName?.trim() || null,
          accountNumberMasked: masked,
          ledgerAccountCode: code,
        },
      })
      await this.audit(tx, actorUserId, 'COMPANY_BANK_CREATED', bank.id, {
        amount: 0,
        type: 'COMPANY_BANK',
        reason: input.name.trim(),
        destination: masked,
        reference: code,
      })
      return this.publicBank(bank)
    })
  }

  async recordDeposit(
    actorUserId: string,
    input: { amount: number; bankAccountId: string; reference?: string; reason: string; idempotencyKey: string },
  ) {
    this.assertAmount(input.amount)
    this.assertText(input.reason, 'Reason')
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx)
      const existing = await this.byIdempotency(tx, input.idempotencyKey)
      if (existing) return this.publicFinance(existing, true)
      await this.ensureChart(tx)
      const bank = await this.requireBank(tx, input.bankAccountId)
      const row = await this.insert(tx, {
        type: 'COMPANY_DEPOSIT',
        amount: input.amount,
        status: CompanyFinanceStatus.COMPLETED,
        description: input.reason.trim(),
        idempotencyKey: input.idempotencyKey,
        bankAccountId: bank.id,
        requestedByUserId: actorUserId,
        completedAt: new Date(),
      })
      await this.postCompany(tx, {
        reference: `COMPANY-DEPOSIT-${row.id}`,
        type: 'COMPANY_CAPITAL',
        description: `Shareholder capital ${input.amount}. Not revenue.`,
        entries: [
          this.line(bank.ledgerAccountCode, 'DEBIT', input.amount, row.id),
          this.line(ACCOUNTS.SHAREHOLDER_CAPITAL, 'CREDIT', input.amount, row.id),
        ],
      })
      await this.audit(tx, actorUserId, 'COMPANY_DEPOSIT_CREATED', row.id, this.auditBody(row, bank.accountNumberMasked))
      return this.publicFinance(row, false)
    })
  }

  async recordExpense(
    actorUserId: string,
    input: {
      amount: number
      category: keyof typeof COMPANY_EXPENSE_ACCOUNTS
      bankAccountId: string
      reason: string
      reference?: string
      payee?: string
      idempotencyKey: string
    },
  ) {
    this.assertAmount(input.amount)
    this.assertText(input.reason, 'Reason')
    const expenseCode = COMPANY_EXPENSE_ACCOUNTS[input.category]
    if (!expenseCode) throw new BadRequestException('Unknown expense category')
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx)
      const existing = await this.byIdempotency(tx, input.idempotencyKey)
      if (existing) return this.publicFinance(existing, true)
      await this.ensureChart(tx)
      const bank = await this.requireBank(tx, input.bankAccountId)
      await this.assertSpendable(tx, bank.ledgerAccountCode, input.amount)
      const row = await this.insert(tx, {
        type: 'COMPANY_EXPENSE',
        amount: input.amount,
        status: CompanyFinanceStatus.COMPLETED,
        description: input.reason.trim(),
        idempotencyKey: input.idempotencyKey,
        bankAccountId: bank.id,
        destinationMasked: input.payee ? maskAccountNumber(input.payee) : null,
        expenseAccountCode: expenseCode,
        requestedByUserId: actorUserId,
        completedAt: new Date(),
      })
      await this.postCompany(tx, {
        reference: `COMPANY-EXPENSE-${row.id}`,
        type: 'COMPANY_EXPENSE',
        description: input.reason.trim(),
        entries: [
          this.line(expenseCode, 'DEBIT', input.amount, row.id),
          this.line(bank.ledgerAccountCode, 'CREDIT', input.amount, row.id),
        ],
      })
      await this.audit(tx, actorUserId, 'COMPANY_EXPENSE_CREATED', row.id, this.auditBody(row, row.destinationMasked))
      return this.publicFinance(row, false)
    })
  }

  async recordTransfer(
    actorUserId: string,
    input: { amount: number; fromBankAccountId: string; toBankAccountId: string; reason: string; idempotencyKey: string },
  ) {
    this.assertAmount(input.amount)
    this.assertText(input.reason, 'Reason')
    if (input.fromBankAccountId === input.toBankAccountId) {
      throw new BadRequestException('Choose two different company accounts')
    }
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx)
      const existing = await this.byIdempotency(tx, input.idempotencyKey)
      if (existing) return this.publicFinance(existing, true)
      await this.ensureChart(tx)
      const from = await this.requireBank(tx, input.fromBankAccountId)
      const to = await this.requireBank(tx, input.toBankAccountId)
      await this.assertSpendable(tx, from.ledgerAccountCode, input.amount)
      const row = await this.insert(tx, {
        type: 'COMPANY_TRANSFER',
        amount: input.amount,
        status: CompanyFinanceStatus.COMPLETED,
        description: input.reason.trim(),
        idempotencyKey: input.idempotencyKey,
        bankAccountId: from.id,
        destinationBankAccountId: to.id,
        destinationMasked: to.accountNumberMasked,
        requestedByUserId: actorUserId,
        completedAt: new Date(),
      })
      await this.postCompany(tx, {
        reference: `COMPANY-TRANSFER-${row.id}`,
        type: 'COMPANY_TRANSFER',
        description: input.reason.trim(),
        entries: [
          this.line(to.ledgerAccountCode, 'DEBIT', input.amount, row.id),
          this.line(from.ledgerAccountCode, 'CREDIT', input.amount, row.id),
        ],
      })
      await this.audit(tx, actorUserId, 'COMPANY_TRANSFER_CREATED', row.id, this.auditBody(row, to.accountNumberMasked))
      return this.publicFinance(row, false)
    })
  }

  async recordAdjustment(
    actorUserId: string,
    input: {
      amount: number
      debitAccountCode: string
      creditAccountCode: string
      reason: string
      reference: string
      idempotencyKey: string
    },
  ) {
    this.assertAmount(input.amount)
    this.assertText(input.reason, 'Reason')
    this.assertText(input.reference, 'Reference')
    if (CUSTOMER_OR_LOCKED.has(input.debitAccountCode) || CUSTOMER_OR_LOCKED.has(input.creditAccountCode)) {
      throw new BadRequestException('An adjustment cannot touch customer funds, revenue, or opening-balance equity')
    }
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx)
      const existing = await this.byIdempotency(tx, input.idempotencyKey)
      if (existing) return this.publicFinance(existing, true)
      await this.ensureChart(tx)
      const row = await this.insert(tx, {
        type: 'COMPANY_ADJUSTMENT',
        amount: input.amount,
        status: CompanyFinanceStatus.COMPLETED,
        description: input.reason.trim(),
        idempotencyKey: input.idempotencyKey,
        expenseAccountCode: input.debitAccountCode,
        requestedByUserId: actorUserId,
        completedAt: new Date(),
      })
      await this.postCompany(tx, {
        reference: `COMPANY-ADJUSTMENT-${input.reference.trim()}`,
        type: 'COMPANY_ADJUSTMENT',
        description: input.reason.trim(),
        entries: [
          this.line(input.debitAccountCode, 'DEBIT', input.amount, row.id),
          this.line(input.creditAccountCode, 'CREDIT', input.amount, row.id),
        ],
      })
      await this.audit(tx, actorUserId, 'COMPANY_ADJUSTMENT_CREATED', row.id, {
        ...this.auditBody(row, null),
        reference: input.reference.trim(),
      })
      return this.publicFinance(row, false)
    })
  }

  async requestDistribution(
    actorUserId: string,
    input: { amount: number; destination: string; reason: string; bankAccountId: string; idempotencyKey: string },
  ) {
    this.assertAmount(input.amount)
    this.assertText(input.reason, 'Reason')
    this.assertText(input.destination, 'Destination')
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx)
      const existing = await this.byIdempotency(tx, input.idempotencyKey)
      if (existing) return this.publicFinance(existing, true)
      await this.ensureChart(tx)
      const bank = await this.requireBank(tx, input.bankAccountId)
      const accounts = await tx.financialAccount.findMany()
      const banks = await tx.companyBankAccount.findMany()
      const view = this.compute(accounts, banks)
      if (input.amount > view.companyCashBalance) {
        throw new BadRequestException('Amount is above company cash')
      }
      if (input.amount > view.availableForDistribution) {
        throw new BadRequestException('Amount is above the distributable company profit')
      }
      await this.assertSpendable(tx, bank.ledgerAccountCode, input.amount)
      const masked = maskAccountNumber(input.destination)
      const row = await this.insert(tx, {
        type: 'OWNER_DISTRIBUTION',
        amount: input.amount,
        status: CompanyFinanceStatus.PENDING,
        description: input.reason.trim(),
        idempotencyKey: input.idempotencyKey,
        bankAccountId: bank.id,
        destinationMasked: masked,
        requestedByUserId: actorUserId,
      })
      await this.postCompany(tx, {
        reference: `COMPANY-RESERVE-${row.id}`,
        type: 'COMPANY_DISTRIBUTION_RESERVED',
        description: 'Cash reserved for an owner distribution. Not revenue and not an expense.',
        entries: [
          this.line(ACCOUNTS.COMPANY_CASH_HELD, 'DEBIT', input.amount, row.id),
          this.line(bank.ledgerAccountCode, 'CREDIT', input.amount, row.id),
        ],
      })
      await this.audit(tx, actorUserId, 'COMPANY_DISTRIBUTION_REQUESTED', row.id, this.auditBody(row, masked))
      return {
        ...this.publicFinance(row, false),
        providerStatus: COMPANY_PROVIDER_STATUS,
        externalTransferCompleted: false,
      }
    })
  }

  async approveDistribution(actorUserId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx)
      const row = await this.requireFinance(tx, id)
      if (row.type !== 'OWNER_DISTRIBUTION') throw new BadRequestException('Not a distribution')
      if (row.status === CompanyFinanceStatus.APPROVED || row.status === CompanyFinanceStatus.PROCESSING) {
        return { ...this.publicFinance(row, true), providerStatus: COMPANY_PROVIDER_STATUS, externalTransferCompleted: false }
      }
      if (row.status !== CompanyFinanceStatus.PENDING) {
        throw new BadRequestException('Distribution cannot be approved')
      }
      const updated = await tx.companyFinanceTransaction.update({
        where: { id: row.id },
        data: {
          status: CompanyFinanceStatus.APPROVED,
          approvedByUserId: actorUserId,
          approvedAt: new Date(),
        },
      })
      await this.audit(tx, actorUserId, 'COMPANY_DISTRIBUTION_APPROVED', row.id, this.auditBody(updated, updated.destinationMasked))
      return {
        ...this.publicFinance(updated, false),
        providerStatus: COMPANY_PROVIDER_STATUS,
        externalTransferCompleted: false,
      }
    })
  }

  async rejectDistribution(actorUserId: string, id: string, reason: string) {
    this.assertText(reason, 'Reason')
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx)
      const row = await this.requireFinance(tx, id)
      if (row.status === CompanyFinanceStatus.REJECTED) return this.publicFinance(row, true)
      if (row.status !== CompanyFinanceStatus.PENDING && row.status !== CompanyFinanceStatus.APPROVED) {
        throw new BadRequestException('Distribution cannot be rejected')
      }
      const bank = await this.requireBank(tx, row.bankAccountId ?? '')
      await this.postCompany(tx, {
        reference: `COMPANY-RESERVE-RELEASE-${row.id}`,
        type: 'COMPANY_DISTRIBUTION_RELEASED',
        description: 'Reserved company cash released. No owner distribution was paid.',
        entries: [
          this.line(bank.ledgerAccountCode, 'DEBIT', row.amount, row.id),
          this.line(ACCOUNTS.COMPANY_CASH_HELD, 'CREDIT', row.amount, row.id),
        ],
      })
      const updated = await tx.companyFinanceTransaction.update({
        where: { id: row.id },
        data: { status: CompanyFinanceStatus.REJECTED, failureReason: reason.trim() },
      })
      await this.audit(tx, actorUserId, 'COMPANY_DISTRIBUTION_REJECTED', row.id, this.auditBody(updated, updated.destinationMasked))
      return this.publicFinance(updated, false)
    })
  }

  /**
   * Verified sandbox or future provider confirmation.
   * Approval alone never reaches COMPLETED.
   */
  async applyVerifiedCallback(input: {
    transactionId: string
    providerReference: string
    status: 'COMPLETED' | 'FAILED' | 'REVERSED'
  }) {
    if (!input.providerReference.trim()) throw new BadRequestException('Invalid provider reference')
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx)
      const row = await this.requireFinance(tx, input.transactionId)
      if (row.type !== 'OWNER_DISTRIBUTION') throw new BadRequestException('Not a distribution')
      if (row.status === CompanyFinanceStatus.COMPLETED && input.status === 'COMPLETED') {
        return this.publicFinance(row, true)
      }
      if (row.status === CompanyFinanceStatus.REVERSED && input.status === 'REVERSED') {
        return this.publicFinance(row, true)
      }
      if (row.status === CompanyFinanceStatus.FAILED && input.status === 'FAILED') {
        return this.publicFinance(row, true)
      }
      const bank = await this.requireBank(tx, row.bankAccountId ?? '')
      if (input.status === 'COMPLETED') {
        if (row.status !== CompanyFinanceStatus.APPROVED && row.status !== CompanyFinanceStatus.PROCESSING) {
          throw new BadRequestException('Distribution is not approved')
        }
        await this.postCompany(tx, {
          reference: `COMPANY-DISTRIBUTION-${row.id}`,
          type: 'OWNER_DISTRIBUTION',
          description: 'Owner distribution confirmed. Revenue and operating expenses are unchanged.',
          entries: [
            this.line(ACCOUNTS.OWNER_DISTRIBUTIONS, 'DEBIT', row.amount, row.id),
            this.line(ACCOUNTS.COMPANY_CASH_HELD, 'CREDIT', row.amount, row.id),
          ],
        })
        const updated = await tx.companyFinanceTransaction.update({
          where: { id: row.id },
          data: {
            status: CompanyFinanceStatus.COMPLETED,
            providerReference: input.providerReference,
            completedAt: new Date(),
          },
        })
        await this.audit(tx, row.requestedByUserId, 'COMPANY_DISTRIBUTION_COMPLETED', row.id, this.auditBody(updated, updated.destinationMasked))
        return this.publicFinance(updated, false)
      }
      if (input.status === 'FAILED') {
        if (row.status === CompanyFinanceStatus.COMPLETED) {
          throw new BadRequestException('A completed distribution cannot be failed')
        }
        await this.releaseReserve(tx, row, bank.ledgerAccountCode)
        const updated = await tx.companyFinanceTransaction.update({
          where: { id: row.id },
          data: { status: CompanyFinanceStatus.FAILED, failureReason: 'Provider did not complete the transfer' },
        })
        await this.audit(tx, row.requestedByUserId, 'COMPANY_DISTRIBUTION_FAILED', row.id, this.auditBody(updated, updated.destinationMasked))
        return this.publicFinance(updated, false)
      }
      if (row.status !== CompanyFinanceStatus.COMPLETED) {
        throw new BadRequestException('Only a completed distribution can be reversed')
      }
      await this.postCompany(tx, {
        reference: `COMPANY-DISTRIBUTION-REVERSAL-${row.id}`,
        type: 'OWNER_DISTRIBUTION_REVERSED',
        description: 'Owner distribution reversed.',
        entries: [
          this.line(bank.ledgerAccountCode, 'DEBIT', row.amount, row.id),
          this.line(ACCOUNTS.OWNER_DISTRIBUTIONS, 'CREDIT', row.amount, row.id),
        ],
      })
      const updated = await tx.companyFinanceTransaction.update({
        where: { id: row.id },
        data: { status: CompanyFinanceStatus.REVERSED },
      })
      await this.audit(tx, row.requestedByUserId, 'COMPANY_DISTRIBUTION_REVERSED', row.id, this.auditBody(updated, updated.destinationMasked))
      return this.publicFinance(updated, false)
    })
  }

  async postOpeningCash(actorUserId: string, input: { amount: number; bankAccountId?: string }) {
    this.assertAmount(input.amount)
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended('buspay:company-opening-cash', 0::bigint))
      `
      const marker = await tx.systemSetting.findUnique({ where: { key: COMPANY_OPENING_SETTING } })
      if (marker) {
        return { alreadyCompleted: true, reference: COMPANY_OPENING_REFERENCE }
      }
      await this.ensureChart(tx)
      const bank = input.bankAccountId
        ? await this.requireBank(tx, input.bankAccountId)
        : await this.requireCashBook(tx)
      await this.insert(tx, {
        type: 'COMPANY_DEPOSIT',
        amount: input.amount,
        status: CompanyFinanceStatus.COMPLETED,
        description: 'One-time company cash opening balance. Not revenue.',
        idempotencyKey: COMPANY_OPENING_REFERENCE,
        bankAccountId: bank.id,
        requestedByUserId: actorUserId,
        completedAt: new Date(),
      })
      await this.postCompany(tx, {
        reference: COMPANY_OPENING_REFERENCE,
        type: 'COMPANY_OPENING_CASH',
        description: 'One-time company cash opening balance. Not revenue and not customer-fund equity.',
        entries: [
          this.line(bank.ledgerAccountCode, 'DEBIT', input.amount, COMPANY_OPENING_REFERENCE),
          this.line(ACCOUNTS.SHAREHOLDER_CAPITAL, 'CREDIT', input.amount, COMPANY_OPENING_REFERENCE),
        ],
      })
      await tx.systemSetting.create({
        data: { key: COMPANY_OPENING_SETTING, value: COMPANY_OPENING_REFERENCE },
      })
      await this.audit(tx, actorUserId, 'COMPANY_OPENING_CASH_POSTED', COMPANY_OPENING_REFERENCE, {
        amount: input.amount,
        type: 'COMPANY_OPENING_CASH',
        reason: 'One-time company cash opening balance',
        destination: bank.accountNumberMasked,
        reference: COMPANY_OPENING_REFERENCE,
      })
      return { alreadyCompleted: false, reference: COMPANY_OPENING_REFERENCE }
    })
  }

  private compute(
    accounts: Array<{ accountCode: string; type: FinancialAccountType; balance: number }>,
    banks: Array<{ ledgerAccountCode: string }>,
  ) {
    const balance = (code: string) => accounts.find((row) => row.accountCode === code)?.balance ?? 0
    const totalRevenue = accounts
      .filter((row) => row.type === FinancialAccountType.REVENUE)
      .reduce((sum, row) => sum + row.balance, 0)
    const totalExpenses = accounts
      .filter((row) => row.type === FinancialAccountType.EXPENSE)
      .reduce((sum, row) => sum + row.balance, 0)
    const netProfit = totalRevenue - totalExpenses
    const distributionBalance = balance(ACCOUNTS.OWNER_DISTRIBUTIONS)
    const completedOwnerDistributions = distributionBalance < 0 ? -distributionBalance : 0
    const retainedEarnings = netProfit - completedOwnerDistributions
    const companyCashBalance = spendableBalance(accounts, banks)
    const profitRoom = Math.max(0, retainedEarnings)
    return {
      totalRevenue,
      totalExpenses,
      netProfit,
      completedOwnerDistributions,
      retainedEarnings,
      openingBalanceEquity: balance(ACCOUNTS.OPENING_BALANCE_EQUITY),
      shareholderCapital: balance(ACCOUNTS.SHAREHOLDER_CAPITAL),
      companyCashBalance,
      availableForDistribution: Math.min(profitRoom, Math.max(0, companyCashBalance)),
      currency: 'TZS' as const,
      providerStatus: COMPANY_PROVIDER_STATUS,
    }
  }

  private async ensureChart(tx: Prisma.TransactionClient) {
    for (const spec of CHART) {
      await tx.financialAccount.upsert({
        where: { accountCode: spec.code },
        create: {
          accountCode: spec.code,
          name: spec.name,
          type: spec.type,
          allowNegative: spec.allowNegative,
          currency: 'TZS',
          status: 'ACTIVE',
        },
        update: {},
      })
    }
    const cash = await tx.companyBankAccount.findUnique({
      where: { ledgerAccountCode: ACCOUNTS.COMPANY_CASH },
    })
    if (!cash) {
      await tx.companyBankAccount.create({
        data: {
          name: 'Company cash',
          accountType: 'CASH',
          accountNumberMasked: '********',
          ledgerAccountCode: ACCOUNTS.COMPANY_CASH,
        },
      })
    }
  }

  private async nextBankCode(tx: Prisma.TransactionClient) {
    const rows = await tx.companyBankAccount.findMany({ select: { ledgerAccountCode: true } })
    const used = new Set(rows.map((row) => row.ledgerAccountCode))
    for (let code = 6110; code < 6190; code += 1) {
      const value = String(code)
      if (!used.has(value) && value !== ACCOUNTS.COMPANY_CASH_HELD) return value
    }
    throw new ConflictException('No company bank account code is available')
  }

  private async assertSpendable(tx: Prisma.TransactionClient, code: string, amount: number) {
    const account = await tx.financialAccount.findUnique({ where: { accountCode: code } })
    if (!account || account.balance < amount) {
      throw new BadRequestException('Company cash is not enough')
    }
  }

  private async requireBank(tx: Prisma.TransactionClient, id: string) {
    const bank = await tx.companyBankAccount.findUnique({ where: { id } })
    if (!bank || bank.status !== 'ACTIVE') throw new NotFoundException('Company bank account was not found')
    return bank
  }

  private async requireCashBook(tx: Prisma.TransactionClient) {
    const bank = await tx.companyBankAccount.findUnique({
      where: { ledgerAccountCode: ACCOUNTS.COMPANY_CASH },
    })
    if (!bank) throw new NotFoundException('Company cash book was not found')
    return bank
  }

  private async requireFinance(tx: Prisma.TransactionClient, id: string) {
    const row = await tx.companyFinanceTransaction.findUnique({ where: { id } })
    if (!row) throw new NotFoundException('Company transaction was not found')
    return row
  }

  private async byIdempotency(tx: Prisma.TransactionClient, key: string) {
    return tx.companyFinanceTransaction.findUnique({ where: { idempotencyKey: key } })
  }

  private async insert(
    tx: Prisma.TransactionClient,
    data: {
      type: 'OWNER_DISTRIBUTION' | 'COMPANY_EXPENSE' | 'COMPANY_TRANSFER' | 'COMPANY_DEPOSIT' | 'COMPANY_ADJUSTMENT'
      amount: number
      status: CompanyFinanceStatus
      description: string
      idempotencyKey: string
      bankAccountId?: string | null
      destinationBankAccountId?: string | null
      destinationMasked?: string | null
      expenseAccountCode?: string | null
      requestedByUserId: string
      completedAt?: Date | null
    },
  ) {
    const now = new Date()
    return tx.companyFinanceTransaction.create({
      data: {
        type: data.type,
        amount: data.amount,
        status: data.status,
        description: data.description,
        reference: `CF-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${String(randomInt(0, 1000000)).padStart(6, '0')}`,
        idempotencyKey: data.idempotencyKey,
        bankAccountId: data.bankAccountId ?? null,
        destinationBankAccountId: data.destinationBankAccountId ?? null,
        destinationMasked: data.destinationMasked ?? null,
        expenseAccountCode: data.expenseAccountCode ?? null,
        requestedByUserId: data.requestedByUserId,
        completedAt: data.completedAt ?? null,
      },
    })
  }

  private async releaseReserve(tx: Prisma.TransactionClient, row: FinanceRow, bankCode: string) {
    await this.postCompany(tx, {
      reference: `COMPANY-RESERVE-RELEASE-${row.id}`,
      type: 'COMPANY_DISTRIBUTION_RELEASED',
      description: 'Reserved company cash released.',
      entries: [
        this.line(bankCode, 'DEBIT', row.amount, row.id),
        this.line(ACCOUNTS.COMPANY_CASH_HELD, 'CREDIT', row.amount, row.id),
      ],
    })
  }

  private async postCompany(tx: Prisma.TransactionClient, posting: LedgerPosting) {
    for (const entry of posting.entries) {
      if (CUSTOMER_OR_LOCKED.has(entry.accountCode)) {
        throw new BadRequestException('Company finance cannot use customer funds or revenue accounts')
      }
    }
    return this.ledger.post(tx, posting)
  }

  private line(accountCode: string, direction: 'DEBIT' | 'CREDIT', amount: number, referenceId: string): LedgerLine {
    return {
      accountCode,
      direction,
      amount,
      referenceType: 'CompanyFinanceTransaction',
      referenceId,
    }
  }

  private async lock(tx: Prisma.TransactionClient) {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended('buspay:company-cash', 0::bigint))
    `
  }

  private async audit(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    action: string,
    entityId: string,
    metadata: { amount: number; type: string; reason: string; destination: string | null; reference: string },
  ) {
    await tx.auditLog.create({
      data: {
        actorUserId,
        action,
        entityType: 'CompanyFinanceTransaction',
        entityId,
        metadata: {
          ...metadata,
          at: new Date().toISOString(),
        },
      },
    })
  }

  private auditBody(row: { amount: number; type: string; description: string; reference: string }, destination: string | null) {
    return {
      amount: row.amount,
      type: row.type,
      reason: row.description,
      destination,
      reference: row.reference,
    }
  }

  private publicBank(bank: BankRow) {
    return {
      id: bank.id,
      name: bank.name,
      accountType: bank.accountType,
      bankName: bank.bankName,
      accountNumberMasked: bank.accountNumberMasked,
      ledgerAccountCode: bank.ledgerAccountCode,
      status: bank.status,
      currency: 'TZS',
    }
  }

  private publicFinance(row: FinanceRow, replay: boolean) {
    return {
      replay,
      id: row.id,
      type: row.type,
      amount: row.amount,
      status: row.status,
      description: row.description,
      reference: row.reference,
      destination: row.destinationMasked,
      expenseAccountCode: row.expenseAccountCode,
      providerReference: row.providerReference,
      providerStatus: COMPANY_PROVIDER_STATUS,
      externalTransferCompleted: row.status === CompanyFinanceStatus.COMPLETED && row.type === 'OWNER_DISTRIBUTION',
      createdAt: row.createdAt,
      approvedAt: row.approvedAt,
      completedAt: row.completedAt,
    }
  }

  private assertAmount(amount: number) {
    if (!Number.isInteger(amount) || amount < 1 || amount > 1_000_000_000) {
      throw new BadRequestException('Amount must be a positive whole number of TZS')
    }
  }

  private assertText(value: string, label: string) {
    if (!value?.trim()) throw new BadRequestException(`${label} is required`)
  }
}

function spendableBalance(
  accounts: Array<{ accountCode: string; balance: number }>,
  banks: Array<{ ledgerAccountCode: string }>,
) {
  const codes = new Set(banks.map((bank) => bank.ledgerAccountCode))
  return accounts
    .filter((row) => codes.has(row.accountCode) && row.accountCode !== ACCOUNTS.COMPANY_CASH_HELD)
    .reduce((sum, row) => sum + row.balance, 0)
}

function operationalCash(transactions: Array<{ type: string; amount: number; status: CompanyFinanceStatus }>) {
  let total = 0
  for (const row of transactions) {
    if (row.type === 'COMPANY_DEPOSIT' && row.status === CompanyFinanceStatus.COMPLETED) total += row.amount
    if (row.type === 'COMPANY_EXPENSE' && row.status === CompanyFinanceStatus.COMPLETED) total -= row.amount
    if (row.type === 'OWNER_DISTRIBUTION' && row.status === CompanyFinanceStatus.COMPLETED) total -= row.amount
    if (row.type === 'OWNER_DISTRIBUTION' && row.status === CompanyFinanceStatus.REVERSED) total += 0
    if (
      row.type === 'OWNER_DISTRIBUTION' &&
      (row.status === CompanyFinanceStatus.PENDING ||
        row.status === CompanyFinanceStatus.APPROVED ||
        row.status === CompanyFinanceStatus.PROCESSING)
    ) {
      total -= row.amount
    }
  }
  return total
}

export function maskAccountNumber(value: string) {
  const compact = value.replace(/\s+/g, '')
  const tail = compact.slice(-4)
  return `${'*'.repeat(8)}${tail || '****'}`
}

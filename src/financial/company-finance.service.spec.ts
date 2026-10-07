import { createHmac } from 'node:crypto'
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common'
import { ROLES_KEY } from '../auth/roles.decorator'
import { FinancialAccountType, UserRole } from '../generated/prisma'
import { ACCOUNTS } from './accounts'
import { CompanyFinanceController } from './company-finance.controller'
import { CompanyFinanceService, maskAccountNumber } from './company-finance.service'
import { receiveCompanyCallback } from './company-finance.webhook'
import { signedDelta } from './ledger.service'

type Acc = {
  id: string
  accountCode: string
  name: string
  type: FinancialAccountType
  balance: number
  allowNegative: boolean
  status: string
}

function world(seed?: { revenue?: number; wallets?: number; conductor?: number; float?: number; clearing?: number }) {
  const accounts: Acc[] = [
    acc('1000', 'PASSENGER_WALLETS', FinancialAccountType.LIABILITY, seed?.wallets ?? 8_200),
    acc('2000', 'CONDUCTOR_EARNINGS', FinancialAccountType.LIABILITY, seed?.conductor ?? 25_800),
    acc('3000', 'WAKALA_FLOAT', FinancialAccountType.LIABILITY, seed?.float ?? 520_000),
    acc('4000', 'BUSPAY_FARE_REVENUE', FinancialAccountType.REVENUE, seed?.revenue ?? 35),
    acc('4100', 'BUSPAY_WITHDRAWAL_FEE_REVENUE', FinancialAccountType.REVENUE, 3_500),
    acc('7000', 'SELCOM_CLEARING', FinancialAccountType.CLEARING, seed?.clearing ?? -10_000),
    acc('8000', 'OPENING_BALANCE_EQUITY', FinancialAccountType.EQUITY, 100),
  ]
  const banks: Array<Record<string, any>> = []
  const finances: Array<Record<string, any>> = []
  const audits: Array<Record<string, any>> = []
  const settings: Array<{ key: string; value: string }> = []
  const ledgerRefs = new Set<string>()
  let chain = Promise.resolve()

  function account(code: string) {
    return accounts.find((row) => row.accountCode === code) ?? null
  }

  const tx = {
    $executeRaw: jest.fn(async () => 0),
    financialAccount: {
      findMany: jest.fn(async (args?: { where?: { accountCode?: { in?: string[] } } }) => {
        const codes = args?.where?.accountCode?.in
        return codes ? accounts.filter((row) => codes.includes(row.accountCode)) : accounts
      }),
      findUnique: jest.fn(async ({ where }: { where: { accountCode?: string } }) => account(where.accountCode ?? '')),
      upsert: jest.fn(async ({ where, create }: { where: { accountCode: string }; create: Acc }) => {
        const found = account(where.accountCode)
        if (found) return found
        const row = { ...create, id: create.accountCode, balance: 0, status: 'ACTIVE' }
        accounts.push(row)
        return row
      }),
      create: jest.fn(async ({ data }: { data: Acc }) => {
        const row = { ...data, id: data.accountCode, balance: data.balance ?? 0 }
        accounts.push(row)
        return row
      }),
    },
    companyBankAccount: {
      findMany: jest.fn(async () => banks),
      findUnique: jest.fn(async ({ where }: { where: { id?: string; ledgerAccountCode?: string } }) => {
        return banks.find((row) => row.id === where.id || row.ledgerAccountCode === where.ledgerAccountCode) ?? null
      }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `bank-${banks.length + 1}`, status: 'ACTIVE', bankName: null, ...data }
        banks.push(row)
        return row
      }),
    },
    companyFinanceTransaction: {
      findMany: jest.fn(async () => finances),
      findUnique: jest.fn(async ({ where }: { where: { id?: string; idempotencyKey?: string } }) => {
        return finances.find((row) => row.id === where.id || row.idempotencyKey === where.idempotencyKey) ?? null
      }),
      create: jest.fn(async ({ data }: { data: Record<string, any> }) => {
        const row = {
          id: `cf-${finances.length + 1}`,
          destinationMasked: null,
          destinationBankAccountId: null,
          expenseAccountCode: null,
          providerReference: null,
          failureReason: null,
          approvedByUserId: null,
          approvedAt: null,
          completedAt: null,
          createdAt: new Date(),
          ...data,
        }
        finances.push(row)
        return row
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = finances.find((item) => item.id === where.id)
        Object.assign(row, data)
        return row
      }),
    },
    systemSetting: {
      findUnique: jest.fn(async ({ where }: { where: { key: string } }) => settings.find((row) => row.key === where.key) ?? null),
      create: jest.fn(async ({ data }: { data: { key: string; value: string } }) => {
        settings.push(data)
        return data
      }),
    },
    auditLog: {
      create: jest.fn(async ({ data }: { data: Record<string, any> }) => {
        audits.push(data)
        return data
      }),
    },
  }

  const prisma = {
    ...tx,
    $transaction: (fn: (client: typeof tx) => Promise<unknown>) => {
      const run = chain.then(() => fn(tx))
      chain = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    },
  }

  const ledger = {
    post: jest.fn(async (_tx: unknown, posting: { reference: string; entries: Array<{ accountCode: string; direction: 'DEBIT' | 'CREDIT'; amount: number }> }) => {
      if (ledgerRefs.has(posting.reference)) return { replay: true }
      for (const entry of posting.entries) {
        const row = account(entry.accountCode)
        if (!row) throw new BadRequestException(`Unknown financial account ${entry.accountCode}`)
        row.balance += signedDelta(row.type, entry.direction, entry.amount)
      }
      ledgerRefs.add(posting.reference)
      return { replay: false }
    }),
  }

  const service = new CompanyFinanceService(prisma as never, ledger as never)
  return { service, accounts, banks, finances, audits, account, ledgerRefs }
}

function acc(code: string, name: string, type: FinancialAccountType, balance: number): Acc {
  return { id: code, accountCode: code, name, type, balance, allowNegative: code === '7000' || code === '8000' || code === '8100', status: 'ACTIVE' }
}

describe('company funds stay separate from customer funds', () => {
  it('does not treat passenger wallets, conductor earnings, Wakala float, or clearing as company cash or revenue', async () => {
    const book = world({ wallets: 8_200, conductor: 25_800, float: 520_000, clearing: -10_000, revenue: 35 })
    const position = await book.service.position()
    const customers = await book.service.customerFunds()
    expect(position.companyCashBalance).toBe(0)
    expect(position.totalRevenue).toBe(35 + 3_500)
    expect(position.totalRevenue).not.toBe(customers.passengerWallets)
    expect(customers).toMatchObject({
      passengerWallets: 8_200,
      conductorEarnings: 25_800,
      wakalaFloat: 520_000,
      providerClearing: -10_000,
    })
    expect(customers.note).toContain('not BusPay company profit')
    expect(position.openingBalanceEquity).toBe(100)
  })

  it('keeps fare revenue and withdrawal-fee revenue when company cash moves', async () => {
    const book = world({ revenue: 35 })
    await book.service.postOpeningCash('admin-1', { amount: 200_000 })
    const bank = book.banks[0]
    await book.service.recordExpense('admin-1', {
      amount: 100_000,
      category: 'INFRASTRUCTURE',
      bankAccountId: bank.id,
      reason: 'Server',
      idempotencyKey: 'exp-1',
    })
    expect(book.account('4000')?.balance).toBe(35)
    expect(book.account('4100')?.balance).toBe(3_500)
    expect(book.account('1000')?.balance).toBe(8_200)
    expect(book.account('2000')?.balance).toBe(25_800)
    expect(book.account('3000')?.balance).toBe(520_000)
    expect(book.account('6100')?.balance).toBe(100_000)
    expect(book.account('5400')?.balance).toBe(100_000)
    const position = await book.service.position()
    expect(position.totalExpenses).toBe(100_000)
    expect(position.netProfit).toBe(35 + 3_500 - 100_000)
    expect(position.shareholderCapital).toBe(200_000)
  })

  it('records capital, expenses, and transfers without calling them revenue', async () => {
    const book = world({ revenue: 0 })
    accountsZeroFee(book)
    await book.service.postOpeningCash('admin-1', { amount: 1_000_000 })
    const cash = book.banks[0]
    const other = await book.service.createBank('admin-1', {
      name: 'Primary',
      bankName: 'Example Bank',
      accountNumber: '123456789012',
    })
    expect(JSON.stringify(other)).not.toContain('123456789012')
    expect(other.accountNumberMasked).toBe(maskAccountNumber('123456789012'))
    await book.service.recordTransfer('admin-1', {
      amount: 400_000,
      fromBankAccountId: cash.id,
      toBankAccountId: other.id,
      reason: 'Move company cash',
      idempotencyKey: 'move-1',
    })
    expect(book.account('6100')?.balance).toBe(600_000)
    expect(book.account(other.ledgerAccountCode)?.balance).toBe(400_000)
    expect(book.account('4000')?.balance).toBe(0)
    expect(book.account('5400')?.balance ?? 0).toBe(0)
    const position = await book.service.position()
    expect(position.companyCashBalance).toBe(1_000_000)
    expect(position.netProfit).toBe(0)
    const report = await book.service.cashReconciliation()
    expect(report[0].status).toBe('MATCH')
  })

  it('refuses an adjustment that touches a customer-fund account', async () => {
    const book = world()
    await expect(
      book.service.recordAdjustment('admin-1', {
        amount: 10_000,
        debitAccountCode: '1000',
        creditAccountCode: '6100',
        reason: 'Do not do this',
        reference: 'BAD-1',
        idempotencyKey: 'bad-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(book.account('1000')?.balance).toBe(8_200)
  })
})

describe('owner distributions', () => {
  it('reserves cash without reducing revenue, then completes once from a verified callback', async () => {
    const book = await funded()
    const bankId = book.banks[0].id
    const requested = await book.service.requestDistribution('admin-1', {
      amount: 500_000,
      destination: '0712345678',
      reason: 'Owner drawing',
      bankAccountId: bankId,
      idempotencyKey: 'dist-1',
    })
    const again = await book.service.requestDistribution('admin-1', {
      amount: 500_000,
      destination: '0712345678',
      reason: 'Owner drawing',
      bankAccountId: bankId,
      idempotencyKey: 'dist-1',
    })
    expect(again.replay).toBe(true)
    expect(book.account('4000')?.balance).toBe(1_000_000)
    expect(book.account('5400')?.balance ?? 0).toBe(0)
    expect(book.account('6100')?.balance).toBe(500_000)
    expect(book.account('8100')?.balance ?? 0).toBe(0)
    expect(requested.externalTransferCompleted).toBe(false)
    const approved = await book.service.approveDistribution('admin-1', requested.id)
    expect(approved.status).toBe('APPROVED')
    expect(approved.providerStatus).toBe('NOT_CONNECTED')
    expect(approved.externalTransferCompleted).toBe(false)
    await expect(
      book.service.applyVerifiedCallback({
        transactionId: requested.id,
        providerReference: 'BANK-1',
        status: 'COMPLETED',
      }),
    ).resolves.toMatchObject({ status: 'COMPLETED', externalTransferCompleted: true })
    await book.service.applyVerifiedCallback({
      transactionId: requested.id,
      providerReference: 'BANK-1',
      status: 'COMPLETED',
    })
    expect(book.account('8100')?.balance).toBe(-500_000)
    expect(book.account('4000')?.balance).toBe(1_000_000)
    const position = await book.service.position()
    expect(position.completedOwnerDistributions).toBe(500_000)
    expect(position.totalRevenue).toBe(1_000_000)
    expect(position.netProfit).toBe(1_000_000)
    expect(book.audits.some((row) => row.action === 'COMPANY_DISTRIBUTION_REQUESTED')).toBe(true)
    expect(JSON.stringify(book.audits)).not.toContain('0712345678')
  })

  it('rejects a distribution above profit or company cash, including a concurrent second request', async () => {
    const profitBook = world({ revenue: 1_000_000 })
    accountsZeroFee(profitBook)
    await profitBook.service.postOpeningCash('admin-1', { amount: 5_000_000 })
    await expect(
      profitBook.service.requestDistribution('admin-1', {
        amount: 2_000_000,
        destination: 'owner',
        reason: 'Too much profit',
        bankAccountId: profitBook.banks[0].id,
        idempotencyKey: 'too-profit',
      }),
    ).rejects.toThrow('distributable')
    const cashBook = world({ revenue: 5_000_000 })
    await cashBook.service.postOpeningCash('admin-1', { amount: 100_000 })
    await expect(
      cashBook.service.requestDistribution('admin-1', {
        amount: 150_000,
        destination: 'owner',
        reason: 'Too much cash',
        bankAccountId: cashBook.banks[0].id,
        idempotencyKey: 'too-cash',
      }),
    ).rejects.toThrow('company cash')
    const book = await funded()
    const bankId = book.banks[0].id
    const results = await Promise.allSettled([
      book.service.requestDistribution('admin-1', {
        amount: 700_000,
        destination: 'owner-a',
        reason: 'A',
        bankAccountId: bankId,
        idempotencyKey: 'race-a',
      }),
      book.service.requestDistribution('admin-1', {
        amount: 600_000,
        destination: 'owner-b',
        reason: 'B',
        bankAccountId: bankId,
        idempotencyKey: 'race-b',
      }),
    ])
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1)
    expect(book.account('6100')?.balance).toBeGreaterThanOrEqual(0)
  })

  it('releases a failed reservation and records a reversal without a second completion', async () => {
    const book = await funded()
    const bankId = book.banks[0].id
    const requested = await book.service.requestDistribution('admin-1', {
      amount: 200_000,
      destination: 'owner',
      reason: 'Drawing',
      bankAccountId: bankId,
      idempotencyKey: 'fail-1',
    })
    await book.service.approveDistribution('admin-1', requested.id)
    await book.service.applyVerifiedCallback({
      transactionId: requested.id,
      providerReference: 'FAIL-1',
      status: 'FAILED',
    })
    expect(book.account('6100')?.balance).toBe(1_000_000)
    expect(book.account('8100')?.balance ?? 0).toBe(0)
    const paid = await book.service.requestDistribution('admin-1', {
      amount: 200_000,
      destination: 'owner',
      reason: 'Drawing',
      bankAccountId: bankId,
      idempotencyKey: 'rev-1',
    })
    await book.service.approveDistribution('admin-1', paid.id)
    await book.service.applyVerifiedCallback({
      transactionId: paid.id,
      providerReference: 'OK-1',
      status: 'COMPLETED',
    })
    await book.service.applyVerifiedCallback({
      transactionId: paid.id,
      providerReference: 'OK-1',
      status: 'REVERSED',
    })
    expect(book.account('6100')?.balance).toBe(1_000_000)
    expect(book.account('8100')?.balance).toBe(0)
    expect(book.finances.find((row) => row.id === paid.id)?.status).toBe('REVERSED')
  })
})

describe('company finance access and provider boundary', () => {
  const secret = process.env.COMPANY_FINANCE_WEBHOOK_SECRET
  const nodeEnv = process.env.NODE_ENV

  afterEach(() => {
    if (secret === undefined) delete process.env.COMPANY_FINANCE_WEBHOOK_SECRET
    else process.env.COMPANY_FINANCE_WEBHOOK_SECRET = secret
    if (nodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = nodeEnv
  })

  it('limits the company finance controller to admins', () => {
    expect(Reflect.getMetadata(ROLES_KEY, CompanyFinanceController)).toEqual([UserRole.ADMIN])
    expect(Reflect.getMetadata(ROLES_KEY, CompanyFinanceController)).not.toContain(UserRole.AGENT)
    expect(Reflect.getMetadata(ROLES_KEY, CompanyFinanceController)).not.toContain(UserRole.CONDUCTOR)
  })

  it('does not let a disconnected provider or a secret field complete a transfer', async () => {
    process.env.COMPANY_FINANCE_WEBHOOK_SECRET = 'sandbox-secret'
    const apply = jest.fn()
    const company = { applyVerifiedCallback: apply } as unknown as CompanyFinanceService
    await expect(receiveCompanyCallback(company, 'selcom', Buffer.from('{}'), 'x')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    )
    const raw = Buffer.from(
      JSON.stringify({ transactionId: 'cf-1', providerReference: 'ABC', status: 'COMPLETED', pin: 'ZXQ-7781-PIN' }),
    )
    await expect(receiveCompanyCallback(company, 'mock', raw, sign(raw))).rejects.toThrow('Secrets are not accepted')
    expect(apply).not.toHaveBeenCalled()
    expect(ACCOUNTS.PASSENGER_WALLETS).toBe('1000')
    expect(ACCOUNTS.COMPANY_CASH).not.toBe(ACCOUNTS.PASSENGER_WALLETS)
    expect(ACCOUNTS.OPENING_BALANCE_EQUITY).toBe('8000')
    expect(ACCOUNTS.RETAINED_EARNINGS).toBe('8200')
  })
})

async function funded() {
  const book = world({ revenue: 1_000_000 })
  accountsZeroFee(book)
  await book.service.postOpeningCash('admin-1', { amount: 1_000_000 })
  return book
}

function accountsZeroFee(book: { accounts: Acc[] }) {
  const fee = book.accounts.find((row) => row.accountCode === '4100')
  if (fee) fee.balance = 0
}

function sign(raw: Buffer) {
  return createHmac('sha256', 'sandbox-secret').update(raw).digest('hex')
}

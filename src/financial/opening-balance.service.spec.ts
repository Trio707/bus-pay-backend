import { FinancialAccountType } from '../generated/prisma'
import { ACCOUNTS } from './accounts'
import { LedgerService } from './ledger.service'
import {
  OPENING_BALANCE_REFERENCE,
  OpeningBalanceService,
} from './opening-balance.service'

type Account = {
  id: string
  accountCode: string
  name: string
  type: FinancialAccountType
  allowNegative: boolean
  balance: number
  status: string
}

function account(
  code: string,
  type: FinancialAccountType,
  balance = 0,
): Account {
  return {
    id: code,
    accountCode: code,
    name: code,
    type,
    allowNegative: true,
    balance,
    status: 'ACTIVE',
  }
}

function world(seed?: {
  wallets?: number[]
  shares?: number[]
  paidWithdrawals?: number[]
  completedPayouts?: number[]
  pendingPayouts?: number[]
  floats?: number[]
  ledger?: Partial<Record<string, number>>
}) {
  const wallets = [...(seed?.wallets ?? [10_000, 5_000])]
  const shares = [...(seed?.shares ?? [500_000])]
  const paidWithdrawals = [...(seed?.paidWithdrawals ?? [])]
  const completedPayouts = [...(seed?.completedPayouts ?? [])]
  const pendingPayouts = [...(seed?.pendingPayouts ?? [])]
  const floats = [...(seed?.floats ?? [2_300_000])]
  const accounts: Account[] = [
    account('1000', FinancialAccountType.LIABILITY, seed?.ledger?.['1000'] ?? 0),
    account('2000', FinancialAccountType.LIABILITY, seed?.ledger?.['2000'] ?? 0),
    account('3000', FinancialAccountType.LIABILITY, seed?.ledger?.['3000'] ?? 0),
    account('4000', FinancialAccountType.REVENUE, seed?.ledger?.['4000'] ?? 35),
  ]
  const transactions: Array<Record<string, unknown>> = []
  const entries: Array<Record<string, unknown>> = []
  const audits: Array<Record<string, unknown>> = []
  let marker: { key: string; value: string } | null = null
  const walletSnapshot = [...wallets]
  const floatSnapshot = [...floats]
  const shareSnapshot = [...shares]

  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

  const api = {
    wallet: {
      aggregate: async () => ({ _sum: { balance: sum(wallets) } }),
    },
    wakalaFloat: {
      aggregate: async () => ({ _sum: { balance: sum(floats) } }),
    },
    paymentTransaction: {
      aggregate: async () => ({ _sum: { conductorShare: sum(shares) } }),
    },
    withdrawal: {
      aggregate: async ({ where }: { where: { status?: string } }) => ({
        _sum: { totalDebit: where.status === 'PAID' ? sum(paidWithdrawals) : 0 },
      }),
    },
    conductorPayout: {
      aggregate: async ({ where }: { where: { status?: string } }) => ({
        _sum: {
          totalDebit: where.status === 'COMPLETED' ? sum(completedPayouts) : sum(pendingPayouts),
        },
      }),
    },
    financialAccount: {
      findMany: async ({ where }: { where: { accountCode: { in: string[] } } }) =>
        accounts.filter((row) => where.accountCode.in.includes(row.accountCode)),
      findUnique: async ({ where }: { where: { accountCode: string } }) =>
        accounts.find((row) => row.accountCode === where.accountCode) ?? null,
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; balance: number }
        data: { balance: number }
      }) => {
        const row = accounts.find((item) => item.id === where.id && item.balance === where.balance)
        if (!row) return { count: 0 }
        row.balance = data.balance
        return { count: 1 }
      },
      upsert: async ({
        where,
        create,
      }: {
        where: { accountCode: string }
        create: {
          accountCode: string
          name: string
          type: FinancialAccountType
          allowNegative: boolean
        }
      }) => {
        const existing = accounts.find((row) => row.accountCode === where.accountCode)
        if (existing) return existing
        const created = account(create.accountCode, create.type)
        created.name = create.name
        created.allowNegative = create.allowNegative
        accounts.push(created)
        return created
      },
    },
    financialLedgerTransaction: {
      findUnique: async ({ where }: { where: { transactionReference: string } }) =>
        transactions.find((row) => row.transactionReference === where.transactionReference) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `lt-${transactions.length + 1}`, entries: [], ...data }
        transactions.push(row)
        return row
      },
    },
    financialLedgerEntry: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        entries.push(data)
        return data
      },
    },
    systemSetting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        marker && marker.key === where.key ? marker : null,
      create: async ({ data }: { data: { key: string; value: string } }) => {
        if (marker?.key === data.key) {
          const error = new Error('unique') as Error & { code: string }
          error.code = 'P2002'
          throw error
        }
        marker = data
        return marker
      },
    },
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data)
        return data
      },
    },
    $queryRaw: async () => [],
    $executeRaw: async () => 1,
  }

  let tail = Promise.resolve()
  const prisma = {
    ...api,
    $transaction: (fn: (tx: typeof api) => Promise<unknown>) => {
      const run = tail.then(() => fn(api))
      tail = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    },
  }
  const service = new OpeningBalanceService(prisma as never, new LedgerService({} as never))
  return {
    service,
    accounts,
    transactions,
    entries,
    audits,
    wallets,
    floats,
    shares,
    walletSnapshot,
    floatSnapshot,
    shareSnapshot,
    balance: (code: string) => accounts.find((row) => row.accountCode === code)?.balance,
  }
}

function row(report: { accounts: Array<{ account: string; status: string; difference: number; operationalBalance: number; ledgerBalance: number }> }, name: string) {
  const found = report.accounts.find((item) => item.account === name)
  if (!found) throw new Error(`missing ${name}`)
  return found
}

describe('opening balance reconciliation', () => {
  it('credits passenger wallets for the current wallet total', async () => {
    const book = world({ wallets: [10_000, 5_000], shares: [0], floats: [0] })
    const result = await book.service.apply('admin-1')
    expect(row(result, 'PASSENGER_WALLETS')).toMatchObject({
      operationalBalance: 15_000,
      ledgerBalance: 15_000,
      difference: 0,
      status: 'MATCH',
    })
    expect(book.balance('1000')).toBe(15_000)
    expect(book.wallets).toEqual(book.walletSnapshot)
  })

  it('credits conductor earnings still owed, including a payout that is not completed', async () => {
    const book = world({
      wallets: [0],
      shares: [500_000],
      paidWithdrawals: [0],
      completedPayouts: [],
      pendingPayouts: [103_500],
      floats: [0],
    })
    const result = await book.service.apply('admin-1')
    expect(row(result, 'CONDUCTOR_EARNINGS')).toMatchObject({
      operationalBalance: 500_000,
      ledgerBalance: 500_000,
      difference: 0,
      status: 'MATCH',
    })
    expect(book.shares).toEqual(book.shareSnapshot)
  })

  it('credits wakala float for the current float total', async () => {
    const book = world({ wallets: [0], shares: [0], floats: [2_300_000] })
    const result = await book.service.apply('admin-1')
    expect(row(result, 'WAKALA_FLOAT')).toMatchObject({
      operationalBalance: 2_300_000,
      ledgerBalance: 2_300_000,
      difference: 0,
      status: 'MATCH',
    })
    expect(book.floats).toEqual(book.floatSnapshot)
  })

  it('keeps an existing fare posting and fills only the historical gap', async () => {
    const book = world({
      wallets: [10_000],
      shares: [665],
      floats: [0],
      ledger: { '1000': -700, '2000': 665, '4000': 35 },
    })
    await book.service.apply('admin-1')
    expect(book.balance('1000')).toBe(10_000)
    expect(book.balance('2000')).toBe(665)
    expect(book.balance('4000')).toBe(35)
    expect(book.wallets).toEqual([10_000])
  })

  it('does not post a second opening balance', async () => {
    const book = world()
    const first = await book.service.apply('admin-1')
    const balances = book.accounts.map((item) => item.balance)
    const second = await book.service.apply('admin-1')
    expect(first.alreadyCompleted).toBe(false)
    expect(second.alreadyCompleted).toBe(true)
    expect(book.transactions).toHaveLength(1)
    expect(book.transactions[0].transactionReference).toBe(OPENING_BALANCE_REFERENCE)
    expect(book.transactions[0].transactionType).toBe('OPENING_BALANCE')
    expect(book.accounts.map((item) => item.balance)).toEqual(balances)
    expect(book.audits).toHaveLength(1)
  })

  it('does not classify the opening balance as revenue', async () => {
    const book = world()
    await book.service.apply('admin-1')
    const equity = book.accounts.find((item) => item.accountCode === ACCOUNTS.OPENING_BALANCE_EQUITY)
    expect(equity?.type).toBe(FinancialAccountType.EQUITY)
    expect(equity?.name).toBe('OPENING_BALANCE_EQUITY')
    expect(book.balance('4000')).toBe(35)
    expect(book.entries.some((entry) => entry.accountId === '4000')).toBe(false)
    expect(book.transactions[0].transactionType).not.toBe('FARE_REVENUE')
  })

  it('matches operational balances after reconciliation', async () => {
    const book = world({
      wallets: [1_500_000],
      shares: [800_000],
      paidWithdrawals: [],
      floats: [2_300_000],
    })
    const result = await book.service.apply('admin-1')
    for (const account of result.accounts) {
      expect(account.difference).toBe(0)
      expect(account.status).toBe('MATCH')
      expect(account.ledgerBalance).toBe(account.operationalBalance)
    }
  })

  it('reports a mismatch instead of hiding it', async () => {
    const book = world({ wallets: [1_500_000], shares: [800_000], floats: [2_300_000] })
    const report = await book.service.reconciliation()
    expect(report.openingBalancePosted).toBe(false)
    for (const account of report.accounts) {
      expect(account.difference).not.toBe(0)
      expect(account.status).toBe('MISMATCH')
    }
    expect(book.transactions).toHaveLength(0)
  })

  it('lets only one concurrent attempt post the opening balance', async () => {
    const book = world()
    const [first, second] = await Promise.all([
      book.service.apply('admin-1'),
      book.service.apply('admin-2'),
    ])
    const completed = [first, second].filter((result) => result.alreadyCompleted)
    expect(book.transactions).toHaveLength(1)
    expect(completed).toHaveLength(1)
    expect(book.audits).toHaveLength(1)
    expect(book.balance('1000')).toBe(15_000)
    expect(book.balance('2000')).toBe(500_000)
    expect(book.balance('3000')).toBe(2_300_000)
  })
})

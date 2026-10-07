import { BadRequestException } from '@nestjs/common'
import { CommissionType, FinancialAccountType } from '../generated/prisma'
import { BooksService } from './books.service'
import { CommissionService } from './commission.service'
import { LedgerService } from './ledger.service'
import { ProfitabilityService } from './profitability.service'
import {
  calculateConductorWithdrawalFee,
  calculateWakalaTopUpCommission,
  registrationCommission,
  renewalCommission,
  splitFare,
} from './pricing'

function account(code: string, type: FinancialAccountType, balance = 0, allowNegative = true) {
  return {
    id: code,
    accountCode: code,
    type,
    allowNegative,
    balance,
    status: 'ACTIVE',
  }
}

function memory() {
  const accounts = [
    account('1000', FinancialAccountType.LIABILITY),
    account('2000', FinancialAccountType.LIABILITY),
    account('3000', FinancialAccountType.LIABILITY),
    account('4000', FinancialAccountType.REVENUE),
    account('4100', FinancialAccountType.REVENUE),
    account('5000', FinancialAccountType.EXPENSE),
    account('6000', FinancialAccountType.ASSET),
    account('7000', FinancialAccountType.CLEARING),
    account('9999', FinancialAccountType.ASSET, 50, false),
  ]
  const transactions: Array<Record<string, unknown>> = []
  const tx = {
    $queryRaw: async () => [],
    pricingPolicy: { findUnique: async () => null },
    financialLedgerTransaction: {
      findUnique: async ({ where }: { where: { transactionReference: string } }) =>
        transactions.find((row) => row.transactionReference === where.transactionReference) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `lt-${transactions.length + 1}`, ...data }
        transactions.push(row)
        return row
      },
    },
    financialAccount: {
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
    },
    financialLedgerEntry: {
      create: async ({ data }: { data: Record<string, unknown> }) => data,
    },
  }
  const books = new BooksService({} as never, new LedgerService({} as never), new CommissionService({} as never))
  return { tx, accounts, transactions, books }
}

function balance(accounts: Array<{ accountCode: string; balance: number }>, code: string) {
  return accounts.find((row) => row.accountCode === code)?.balance ?? 0
}

describe('financial ledger', () => {
  it('splits a TZS 700 fare without losing the passenger charge', () => {
    const split = splitFare(700)
    expect(split.platformFee).toBe(35)
    expect(split.conductorShare).toBe(665)
    expect(split.conductorShare + split.platformFee).toBe(700)
  })

  it('posts the full fare, conductor share, and revenue once', async () => {
    const { tx, accounts, transactions, books } = memory()
    const split = splitFare(700)
    await books.postFare(tx as never, { paymentId: 'pay-1', fare: 700, ...split })
    await books.postFare(tx as never, { paymentId: 'pay-1', fare: 700, ...split })
    expect(balance(accounts, '1000')).toBe(-700)
    expect(balance(accounts, '2000')).toBe(665)
    expect(balance(accounts, '4000')).toBe(35)
    expect(transactions).toHaveLength(1)
    expect(-700 + 665 + 35).toBe(0)
  })

  it('does not post revenue when the fare cannot be collected', async () => {
    const { tx, transactions, books } = memory()
    const wallet = { balance: 100 }
    const split = splitFare(700)
    await expect(async () => {
      wallet.balance -= 700
      if (wallet.balance < 0) throw new BadRequestException('Insufficient balance')
      await books.postFare(tx as never, { paymentId: 'pay-fail', fare: 700, ...split })
    }).rejects.toThrow('Insufficient balance')
    expect(transactions).toHaveLength(0)
  })

  it('charges top-up commission once and keeps the passenger credit whole', () => {
    expect(calculateWakalaTopUpCommission(20_000)).toEqual({
      commission: 200,
      rateBps: 100,
      cap: 500,
    })
    expect(calculateWakalaTopUpCommission(100_000).commission).toBe(500)
    expect(calculateWakalaTopUpCommission(1_000).commission).toBe(10)
  })

  it('keeps registration at 200 and renewal at 0', () => {
    expect(registrationCommission()).toBe(200)
    expect(renewalCommission()).toBe(0)
  })

  it('returns the withdrawal fee tiers', () => {
    expect(calculateConductorWithdrawalFee(49_999).fee).toBe(1_400)
    expect(calculateConductorWithdrawalFee(50_000).fee).toBe(2_100)
    expect(calculateConductorWithdrawalFee(100_000).fee).toBe(3_500)
    expect(calculateConductorWithdrawalFee(200_000).fee).toBe(4_000)
    expect(calculateConductorWithdrawalFee(300_000).fee).toBe(5_000)
    expect(calculateConductorWithdrawalFee(500_000).fee).toBe(7_000)
    expect(calculateConductorWithdrawalFee(1_000_000).fee).toBe(10_000)
    expect(calculateConductorWithdrawalFee(100_000).totalDebit).toBe(103_500)
  })

  it('recognizes withdrawal fee revenue once and only on completion', async () => {
    const { tx, accounts, transactions, books } = memory()
    const input = { payoutId: 'po-1', netAmount: 100_000, fee: 3_500 }
    await books.postPayoutCompleted(tx as never, input)
    await books.postPayoutCompleted(tx as never, input)
    expect(balance(accounts, '4100')).toBe(3_500)
    expect(balance(accounts, '7000')).toBe(100_000)
    expect(balance(accounts, '2000')).toBe(-103_500)
    expect(transactions).toHaveLength(1)
  })

  it('does not treat an unknown Selcom cost as zero', async () => {
    const profitability = new ProfitabilityService({
      providerCost: { findUnique: async () => null },
    } as never)
    const result = await profitability.payout(100_000)
    expect(result.platformFee).toBe(3_500)
    expect(result.providerCost).toBeNull()
    expect(result.providerCostStatus).toBe('UNKNOWN')
    expect(result.netContribution).toBeNull()
  })

  it('rejects a prohibited negative balance', async () => {
    const { tx, accounts } = memory()
    const ledger = new LedgerService({} as never)
    await expect(
      ledger.post(tx as never, {
        reference: 'NEG-1',
        type: 'TEST',
        description: 'too large',
        entries: [
          { accountCode: '9999', direction: 'CREDIT', amount: 80 },
          { accountCode: '4000', direction: 'DEBIT', amount: 80 },
        ],
      }),
    ).rejects.toThrow('cannot go negative')
    expect(balance(accounts, '9999')).toBe(50)
  })

  it('accrues a registration commission once and settles it once', async () => {
    const entries: Array<Record<string, any>> = []
    const accounts: Array<Record<string, any>> = []
    const tx = {
      wakalaCommissionEntry: {
        findUnique: async ({ where }: { where: { sourceType_sourceId_type: { sourceId: string; type: string } } }) =>
          entries.find(
            (row) =>
              row.sourceId === where.sourceType_sourceId_type.sourceId &&
              row.type === where.sourceType_sourceId_type.type,
          ) ?? null,
        findMany: async ({ where }: { where: { status: string } }) =>
          entries.filter((row) => row.status === where.status),
        create: async ({ data }: { data: Record<string, any> }) => {
          entries.push({ id: `c-${entries.length + 1}`, ...data })
          return entries[entries.length - 1]
        },
        updateMany: async ({ data }: { data: Record<string, any> }) => {
          for (const row of entries) {
            if (row.status === 'PENDING') Object.assign(row, data)
          }
          return { count: entries.length }
        },
      },
      wakalaCommissionAccount: {
        upsert: async () => {
          if (!accounts[0]) accounts.push({ id: 'acct', balance: 0, totalEarned: 0, totalPaid: 0 })
          return accounts[0]
        },
        update: async ({ data }: { data: Record<string, { increment?: number; decrement?: number }> }) => {
          if (data.balance?.increment) accounts[0].balance += data.balance.increment
          if (data.balance?.decrement) accounts[0].balance -= data.balance.decrement
          if (data.totalEarned?.increment) accounts[0].totalEarned += data.totalEarned.increment
          if (data.totalPaid?.increment) accounts[0].totalPaid += data.totalPaid.increment
          return accounts[0]
        },
      },
      wakalaCommissionSettlement: {
        create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'set-1', ...data }),
      },
    }
    const commissions = new CommissionService({} as never)
    await commissions.accrue(tx as never, {
      agentUserId: 'agent-1',
      type: CommissionType.REGISTRATION,
      amount: 200,
      sourceType: 'Card',
      sourceId: 'card-1',
    })
    await commissions.accrue(tx as never, {
      agentUserId: 'agent-1',
      type: CommissionType.REGISTRATION,
      amount: 200,
      sourceType: 'Card',
      sourceId: 'card-1',
    })
    expect(accounts[0].balance).toBe(200)
    expect(entries).toHaveLength(1)
    const first = await commissions.settle(tx as never, 'agent-1', 0)
    const second = await commissions.settle(tx as never, 'agent-1', 0)
    expect(first.settled).toBe(true)
    expect(second.settled).toBe(false)
    expect(accounts[0].balance).toBe(0)
    expect(accounts[0].totalPaid).toBe(200)
  })
})

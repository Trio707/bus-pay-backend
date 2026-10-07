import { BadRequestException, Injectable } from '@nestjs/common'
import {
  ConductorPayoutStatus,
  FinancialAccountType,
  Prisma,
  TransactionStatus,
  WithdrawalStatus,
} from '../generated/prisma'
import { PrismaService } from '../prisma/prisma.service'
import { ACCOUNTS } from './accounts'
import { LedgerService, type LedgerLine } from './ledger.service'

export const OPENING_BALANCE_REFERENCE = 'OPENING-BALANCE-20261007'
export const OPENING_BALANCE_SETTING = 'financial.opening-balance'

const CONTROLS = [
  { account: 'PASSENGER_WALLETS', code: ACCOUNTS.PASSENGER_WALLETS, type: FinancialAccountType.LIABILITY },
  { account: 'CONDUCTOR_EARNINGS', code: ACCOUNTS.CONDUCTOR_EARNINGS, type: FinancialAccountType.LIABILITY },
  { account: 'WAKALA_FLOAT', code: ACCOUNTS.WAKALA_FLOAT, type: FinancialAccountType.LIABILITY },
] as const

type ControlName = (typeof CONTROLS)[number]['account']
type ControlTotals = Record<ControlName, number>
type Reader = Prisma.TransactionClient | PrismaService

/**
 * One-time bridge from balances that existed before the ledger.
 * Conductor control total is earnings still owed on the books:
 * successful shares, minus paid cash-outs, minus completed payouts.
 * A payout still in progress stays in that total because the ledger
 * debits it only when the payout is completed.
 */
@Injectable()
export class OpeningBalanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {}

  reconciliation() {
    return this.report(this.prisma)
  }

  async apply(actorUserId: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended('buspay:opening-balance', 0::bigint))
      `
      const marker = await tx.systemSetting.findUnique({
        where: { key: OPENING_BALANCE_SETTING },
      })
      if (marker) {
        return {
          alreadyCompleted: true,
          ...(await this.report(tx)),
        }
      }

      const operational = await this.operational(tx)
      const ledgerBalances = await this.ledgerBalances(tx)
      const entries = buildOpeningLines(operational, ledgerBalances)
      if (entries.length > 0) {
        await this.ensureAccounts(tx)
        await this.ledger.post(tx, {
          reference: OPENING_BALANCE_REFERENCE,
          type: 'OPENING_BALANCE',
          description: `Opening balance reconciliation ${OPENING_BALANCE_REFERENCE}. Not revenue or expense.`,
          entries,
        })
      }

      await tx.systemSetting.create({
        data: {
          key: OPENING_BALANCE_SETTING,
          value: OPENING_BALANCE_REFERENCE,
        },
      })
      const report = await this.report(tx)
      if (report.accounts.some((row) => row.status === 'MISMATCH')) {
        throw new BadRequestException('Opening balance did not reconcile the control accounts')
      }
      await tx.auditLog.create({
        data: {
          actorUserId,
          action: 'OPENING_BALANCE_RECONCILED',
          entityType: 'FinancialLedgerTransaction',
          entityId: OPENING_BALANCE_REFERENCE,
          metadata: {
            reference: OPENING_BALANCE_REFERENCE,
            description: 'One-time opening balance reconciliation',
            createdBy: actorUserId,
            accounts: report.accounts,
          },
        },
      })
      return {
        alreadyCompleted: false,
        ...report,
      }
    })
  }

  private async report(db: Reader) {
    const [operational, ledgerBalances, marker] = await Promise.all([
      this.operational(db),
      this.ledgerBalances(db),
      db.systemSetting.findUnique({ where: { key: OPENING_BALANCE_SETTING } }),
    ])
    return {
      reference: OPENING_BALANCE_REFERENCE,
      openingBalancePosted: Boolean(marker),
      accounts: CONTROLS.map((row) => {
        const operationalBalance = operational[row.account]
        const ledgerBalance = ledgerBalances[row.account]
        const difference = ledgerBalance - operationalBalance
        return {
          account: row.account,
          accountCode: row.code,
          operationalBalance,
          ledgerBalance,
          difference,
          status: difference === 0 ? 'MATCH' : 'MISMATCH',
        }
      }),
    }
  }

  private async operational(db: Reader): Promise<ControlTotals> {
    const [wallets, taps, withdrawals, payouts, floats] = await Promise.all([
      db.wallet.aggregate({ _sum: { balance: true } }),
      db.paymentTransaction.aggregate({
        where: { status: TransactionStatus.SUCCESS },
        _sum: { conductorShare: true },
      }),
      db.withdrawal.aggregate({
        where: {
          conductorUserId: { not: null },
          status: WithdrawalStatus.PAID,
        },
        _sum: { totalDebit: true },
      }),
      db.conductorPayout.aggregate({
        where: { status: ConductorPayoutStatus.COMPLETED },
        _sum: { totalDebit: true },
      }),
      db.wakalaFloat.aggregate({ _sum: { balance: true } }),
    ])
    return {
      PASSENGER_WALLETS: wallets._sum.balance ?? 0,
      CONDUCTOR_EARNINGS:
        (taps._sum.conductorShare ?? 0) -
        (withdrawals._sum.totalDebit ?? 0) -
        (payouts._sum.totalDebit ?? 0),
      WAKALA_FLOAT: floats._sum.balance ?? 0,
    }
  }

  private async ledgerBalances(db: Reader): Promise<ControlTotals> {
    const rows = await db.financialAccount.findMany({
      where: { accountCode: { in: CONTROLS.map((row) => row.code) } },
    })
    const byCode = new Map(rows.map((row) => [row.accountCode, row.balance]))
    return {
      PASSENGER_WALLETS: byCode.get(ACCOUNTS.PASSENGER_WALLETS) ?? 0,
      CONDUCTOR_EARNINGS: byCode.get(ACCOUNTS.CONDUCTOR_EARNINGS) ?? 0,
      WAKALA_FLOAT: byCode.get(ACCOUNTS.WAKALA_FLOAT) ?? 0,
    }
  }

  private async ensureAccounts(tx: Prisma.TransactionClient) {
    const specs = [
      ...CONTROLS.map((row) => ({ code: row.code, name: row.account, type: row.type })),
      {
        code: ACCOUNTS.OPENING_BALANCE_EQUITY,
        name: 'OPENING_BALANCE_EQUITY',
        type: FinancialAccountType.EQUITY,
      },
    ]
    for (const spec of specs) {
      await tx.financialAccount.upsert({
        where: { accountCode: spec.code },
        create: {
          accountCode: spec.code,
          name: spec.name,
          type: spec.type,
          allowNegative: true,
          currency: 'TZS',
          status: 'ACTIVE',
        },
        update: {},
      })
    }
  }
}

export function buildOpeningLines(operational: ControlTotals, ledgerBalances: ControlTotals): LedgerLine[] {
  const entries: LedgerLine[] = []
  let debit = 0
  let credit = 0
  for (const row of CONTROLS) {
    const delta = operational[row.account] - ledgerBalances[row.account]
    if (!Number.isInteger(delta)) {
      throw new BadRequestException('Opening balances must be whole TZS')
    }
    if (delta === 0) continue
    const line: LedgerLine = {
      accountCode: row.code,
      direction: delta > 0 ? 'CREDIT' : 'DEBIT',
      amount: Math.abs(delta),
      referenceType: 'OPENING_BALANCE',
      referenceId: OPENING_BALANCE_REFERENCE,
      description: `Opening balance ${row.account}`,
    }
    entries.push(line)
    if (delta > 0) credit += delta
    else debit += -delta
  }
  const net = credit - debit
  if (net === 0) return entries
  entries.push({
    accountCode: ACCOUNTS.OPENING_BALANCE_EQUITY,
    direction: net > 0 ? 'DEBIT' : 'CREDIT',
    amount: Math.abs(net),
    referenceType: 'OPENING_BALANCE',
    referenceId: OPENING_BALANCE_REFERENCE,
    description: 'Opening balance equity. Not revenue or expense.',
  })
  return entries
}

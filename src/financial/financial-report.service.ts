import { Injectable } from '@nestjs/common'
import { FinancialAccountType } from '../generated/prisma'
import { PrismaService } from '../prisma/prisma.service'
import { ProfitabilityService } from './profitability.service'
import { CommissionService } from './commission.service'

@Injectable()
export class FinancialReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profits: ProfitabilityService,
    private readonly commissions: CommissionService,
  ) {}

  accounts() {
    return this.prisma.financialAccount.findMany({ orderBy: { accountCode: 'asc' } })
  }

  async ledger(page = 1, limit = 50) {
    const take = Math.min(100, Math.max(1, limit))
    const skip = (Math.max(1, page) - 1) * take
    const [total, transactions] = await Promise.all([
      this.prisma.financialLedgerTransaction.count(),
      this.prisma.financialLedgerTransaction.findMany({
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          entries: {
            include: { account: { select: { accountCode: true, name: true } } },
          },
        },
      }),
    ])
    return { page: Math.max(1, page), limit: take, total, transactions }
  }

  async revenue() {
    return this.movement(FinancialAccountType.REVENUE)
  }

  async expenses() {
    return this.movement(FinancialAccountType.EXPENSE)
  }

  async profitability() {
    const [fare, payout, topUp, provider] = await Promise.all([
      this.profits.fare(700),
      this.profits.payout(100_000),
      this.profits.topUp(20_000),
      this.profits.providerCost('PAYOUT'),
    ])
    return {
      examples: { fare, payout, topUp },
      selcomPayoutCost: provider,
      note: 'UNKNOWN means no confirmed Selcom or SMS cost is configured. It is not zero.',
    }
  }

  wakalaCommissions() {
    return this.prisma.wakalaCommissionAccount.findMany({
      orderBy: { updatedAt: 'desc' },
      include: {
        agent: { select: { id: true, firstName: true, lastName: true, tillNumber: true } },
        entries: { orderBy: { createdAt: 'desc' }, take: 20 },
      },
    })
  }

  settleWakala(agentUserId: string) {
    return this.prisma.$transaction((tx) => this.commissions.settle(tx, agentUserId, 0))
  }

  private async movement(type: FinancialAccountType) {
    const accounts = await this.prisma.financialAccount.findMany({ where: { type } })
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const startOfMonth = new Date(startOfDay.getFullYear(), startOfDay.getMonth(), 1)
    const ids = accounts.map((account) => account.id)
    const [today, month] = await Promise.all([
      this.sumSince(ids, startOfDay),
      this.sumSince(ids, startOfMonth),
    ])
    return {
      accounts: accounts.map((account) => ({
        accountCode: account.accountCode,
        name: account.name,
        balance: account.balance,
      })),
      total: accounts.reduce((sum, account) => sum + account.balance, 0),
      today,
      month,
    }
  }

  private async sumSince(accountIds: string[], since: Date) {
    if (accountIds.length === 0) return 0
    const rows = await this.prisma.financialLedgerEntry.findMany({
      where: { accountId: { in: accountIds }, createdAt: { gte: since } },
      select: { direction: true, amount: true },
    })
    return rows.reduce((total, row) => {
      return total + (row.direction === 'CREDIT' ? row.amount : -row.amount)
    }, 0)
  }
}

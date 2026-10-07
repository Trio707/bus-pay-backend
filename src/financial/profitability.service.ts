import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import {
  calculateWakalaTopUpCommission,
  splitFare,
  calculateConductorWithdrawalFee,
} from './pricing'

export type CostStatus = 'KNOWN' | 'UNKNOWN'

@Injectable()
export class ProfitabilityService {
  constructor(private readonly prisma: PrismaService) {}

  async providerCost(operation: string) {
    const row = await this.prisma.providerCost.findUnique({
      where: { provider_operation: { provider: 'SELCOM', operation } },
    })
    if (!row?.configured || row.amount == null) {
      return { provider: 'SELCOM', operation, amount: null, status: 'UNKNOWN' as const }
    }
    return { provider: 'SELCOM', operation, amount: row.amount, status: 'KNOWN' as const }
  }

  async fare(fare: number) {
    const split = splitFare(fare)
    const provider = await this.providerCost('FARE')
    const sms = await this.providerCost('SMS')
    return {
      grossFare: split.fare,
      conductorShare: split.conductorShare,
      buspayRevenue: split.platformFee,
      providerCost: provider.amount,
      providerCostStatus: provider.status,
      smsCost: sms.amount,
      smsCostStatus: sms.status,
      wakalaCommission: 0,
      ...net(split.platformFee, 0, provider.status === 'KNOWN' ? provider.amount : null, sms.status === 'KNOWN' ? sms.amount : null),
    }
  }

  async payout(amount: number) {
    const quote = calculateConductorWithdrawalFee(amount)
    const provider = await this.providerCost('PAYOUT')
    const sms = await this.providerCost('SMS')
    return {
      requestedAmount: amount,
      platformFee: quote.fee,
      totalDebit: quote.totalDebit,
      providerCost: provider.amount,
      providerCostStatus: provider.status,
      smsCost: sms.amount,
      smsCostStatus: sms.status,
      ...net(quote.fee, 0, provider.status === 'KNOWN' ? provider.amount : null, sms.status === 'KNOWN' ? sms.amount : null),
    }
  }

  async topUp(amount: number) {
    const quote = calculateWakalaTopUpCommission(amount)
    const provider = await this.providerCost('TOPUP')
    return {
      topUpAmount: amount,
      wakalaCommission: quote.commission,
      rateBps: quote.rateBps,
      cap: quote.cap,
      providerCost: provider.amount,
      providerCostStatus: provider.status,
      ...net(0, quote.commission, provider.status === 'KNOWN' ? provider.amount : null, 0),
    }
  }
}

function net(
  revenue: number,
  commission: number,
  providerCost: number | null,
  smsCost: number | null,
) {
  if (providerCost == null || smsCost == null) {
    return { netContribution: null, netContributionStatus: 'UNKNOWN' as CostStatus }
  }
  return {
    netContribution: revenue - commission - providerCost - smsCost,
    netContributionStatus: 'KNOWN' as CostStatus,
  }
}

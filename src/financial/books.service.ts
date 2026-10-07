import { Injectable } from '@nestjs/common'
import { CommissionType, type Prisma } from '../generated/prisma'
import { PrismaService } from '../prisma/prisma.service'
import { ACCOUNTS } from './accounts'
import { CommissionService } from './commission.service'
import { LedgerService, type LedgerLine } from './ledger.service'
import {
  calculateConductorWithdrawalFee,
  calculateWakalaTopUpCommission,
  registrationCommission,
  renewalCommission,
  splitFare,
  type WithdrawalFeeTier,
} from './pricing'

@Injectable()
export class BooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly commissions: CommissionService,
  ) {}

  async splitFare(db: Prisma.TransactionClient | PrismaService, fare: number) {
    const rateBps = await this.numberPolicy(db, 'FARE_PLATFORM_RATE_BPS', 500)
    return splitFare(fare, rateBps)
  }

  async quoteWithdrawal(amount: number, db: Prisma.TransactionClient | PrismaService = this.prisma) {
    const tiers = await this.tierPolicy(db)
    return calculateConductorWithdrawalFee(amount, tiers)
  }

  async postFare(
    tx: Prisma.TransactionClient,
    input: {
      paymentId: string
      fare: number
      conductorShare: number
      platformFee: number
    },
  ) {
    const entries: LedgerLine[] = [
      {
        accountCode: ACCOUNTS.PASSENGER_WALLETS,
        direction: 'DEBIT' as const,
        amount: input.fare,
        referenceType: 'PaymentTransaction',
        referenceId: input.paymentId,
      },
      {
        accountCode: ACCOUNTS.CONDUCTOR_EARNINGS,
        direction: 'CREDIT' as const,
        amount: input.conductorShare,
        referenceType: 'PaymentTransaction',
        referenceId: input.paymentId,
      },
    ]
    if (input.platformFee > 0) {
      entries.push({
        accountCode: ACCOUNTS.FARE_REVENUE,
        direction: 'CREDIT',
        amount: input.platformFee,
        referenceType: 'PaymentTransaction',
        referenceId: input.paymentId,
      })
    }
    return this.ledger.post(tx, {
      reference: `FARE-${input.paymentId}`,
      type: 'FARE_REVENUE',
      description: `Fare ${input.fare}. Conductor ${input.conductorShare}. Revenue ${input.platformFee}.`,
      entries,
    })
  }

  async postTopUp(
    tx: Prisma.TransactionClient,
    input: { topUpId: string; agentUserId: string; amount: number },
  ) {
    await this.ledger.post(tx, {
      reference: `TOPUP-${input.topUpId}`,
      type: 'PASSENGER_TOPUP',
      description: `Passenger cash top-up ${input.amount}`,
      entries: [
        {
          accountCode: ACCOUNTS.WAKALA_FLOAT,
          direction: 'DEBIT',
          amount: input.amount,
          referenceType: 'TopUp',
          referenceId: input.topUpId,
        },
        {
          accountCode: ACCOUNTS.PASSENGER_WALLETS,
          direction: 'CREDIT',
          amount: input.amount,
          referenceType: 'TopUp',
          referenceId: input.topUpId,
        },
      ],
    })
    const policy = await this.topUpPolicy(tx)
    const quote = calculateWakalaTopUpCommission(input.amount, policy)
    if (quote.commission < 1) return { commission: 0 }
    const accrued = await this.commissions.accrue(tx, {
      agentUserId: input.agentUserId,
      type: CommissionType.TOP_UP,
      amount: quote.commission,
      sourceType: 'TopUp',
      sourceId: input.topUpId,
    })
    if (!accrued.replay) {
      await this.expenseCommission(tx, `TOPUP-COMMISSION-${input.topUpId}`, quote.commission, 'TopUp', input.topUpId)
    }
    return { commission: quote.commission, replay: accrued.replay }
  }

  async postRegistration(
    tx: Prisma.TransactionClient,
    input: { cardId: string; agentUserId: string },
  ) {
    const amount = registrationCommission(await this.numberPolicy(tx, 'WAKALA_REGISTRATION_COMMISSION', 200))
    if (amount < 1) return { commission: 0 }
    const accrued = await this.commissions.accrue(tx, {
      agentUserId: input.agentUserId,
      type: CommissionType.REGISTRATION,
      amount,
      sourceType: 'Card',
      sourceId: input.cardId,
    })
    if (!accrued.replay) {
      await this.expenseCommission(tx, `REGISTRATION-COMMISSION-${input.cardId}`, amount, 'Card', input.cardId)
    }
    return { commission: amount, replay: accrued.replay }
  }

  async postRenewal(tx: Prisma.TransactionClient, input: { cardId: string; agentUserId?: string }) {
    const amount = renewalCommission(await this.numberPolicy(tx, 'WAKALA_RENEWAL_COMMISSION', 0))
    if (amount < 1 || !input.agentUserId) return { commission: 0 }
    const accrued = await this.commissions.accrue(tx, {
      agentUserId: input.agentUserId,
      type: CommissionType.RENEWAL,
      amount,
      sourceType: 'CardRenewal',
      sourceId: input.cardId,
    })
    if (!accrued.replay) {
      await this.expenseCommission(tx, `RENEWAL-COMMISSION-${input.cardId}`, amount, 'CardRenewal', input.cardId)
    }
    return { commission: amount }
  }

  async postCashOut(
    tx: Prisma.TransactionClient,
    input: { withdrawalId: string; cashAmount: number; fee: number },
  ) {
    const entries: LedgerLine[] = [
      {
        accountCode: ACCOUNTS.CONDUCTOR_EARNINGS,
        direction: 'DEBIT' as const,
        amount: input.cashAmount + input.fee,
        referenceType: 'Withdrawal',
        referenceId: input.withdrawalId,
      },
      {
        accountCode: ACCOUNTS.WAKALA_FLOAT,
        direction: 'CREDIT' as const,
        amount: input.cashAmount,
        referenceType: 'Withdrawal',
        referenceId: input.withdrawalId,
      },
    ]
    if (input.fee > 0) {
      entries.push({
        accountCode: ACCOUNTS.WITHDRAWAL_FEE_REVENUE,
        direction: 'CREDIT',
        amount: input.fee,
        referenceType: 'Withdrawal',
        referenceId: input.withdrawalId,
      })
    }
    return this.ledger.post(tx, {
      reference: `CASHOUT-${input.withdrawalId}`,
      type: 'CONDUCTOR_CASH_OUT',
      description: `Cash ${input.cashAmount}. Fee ${input.fee}.`,
      entries,
    })
  }

  async postMobileDeposit(
    tx: Prisma.TransactionClient,
    input: { depositId: string; amount: number },
  ) {
    return this.ledger.post(tx, {
      reference: `DEPOSIT-${input.depositId}`,
      type: 'MOBILE_MONEY_DEPOSIT',
      description: `Passenger mobile-money deposit ${input.amount}. Not fare revenue. Provider fee not recorded.`,
      entries: [
        {
          accountCode: ACCOUNTS.SELCOM_CLEARING,
          direction: 'DEBIT',
          amount: input.amount,
          referenceType: 'WalletDeposit',
          referenceId: input.depositId,
        },
        {
          accountCode: ACCOUNTS.PASSENGER_WALLETS,
          direction: 'CREDIT',
          amount: input.amount,
          referenceType: 'WalletDeposit',
          referenceId: input.depositId,
        },
      ],
    })
  }

  async reverseMobileDeposit(
    tx: Prisma.TransactionClient,
    input: { depositId: string; amount: number },
  ) {
    return this.ledger.post(tx, {
      reference: `DEPOSIT-REVERSAL-${input.depositId}`,
      type: 'MOBILE_MONEY_DEPOSIT_REVERSED',
      description: `Reversal of mobile-money deposit ${input.depositId}`,
      entries: [
        {
          accountCode: ACCOUNTS.PASSENGER_WALLETS,
          direction: 'DEBIT',
          amount: input.amount,
          referenceType: 'WalletDeposit',
          referenceId: input.depositId,
        },
        {
          accountCode: ACCOUNTS.SELCOM_CLEARING,
          direction: 'CREDIT',
          amount: input.amount,
          referenceType: 'WalletDeposit',
          referenceId: input.depositId,
        },
      ],
    })
  }

  async postPayoutCompleted(
    tx: Prisma.TransactionClient,
    input: { payoutId: string; netAmount: number; fee: number },
  ) {
    const entries: LedgerLine[] = [
      {
        accountCode: ACCOUNTS.CONDUCTOR_EARNINGS,
        direction: 'DEBIT' as const,
        amount: input.netAmount + input.fee,
        referenceType: 'ConductorPayout',
        referenceId: input.payoutId,
      },
      {
        accountCode: ACCOUNTS.SELCOM_CLEARING,
        direction: 'CREDIT' as const,
        amount: input.netAmount,
        referenceType: 'ConductorPayout',
        referenceId: input.payoutId,
      },
    ]
    if (input.fee > 0) {
      entries.push({
        accountCode: ACCOUNTS.WITHDRAWAL_FEE_REVENUE,
        direction: 'CREDIT',
        amount: input.fee,
        referenceType: 'ConductorPayout',
        referenceId: input.payoutId,
      })
    }
    return this.ledger.post(tx, {
      reference: `PAYOUT-${input.payoutId}`,
      type: 'CONDUCTOR_PAYOUT',
      description: `Payout ${input.netAmount}. Fee ${input.fee}. Provider cost UNKNOWN.`,
      entries,
    })
  }

  async reversePayout(
    tx: Prisma.TransactionClient,
    input: { payoutId: string; netAmount: number; fee: number },
  ) {
    const entries: LedgerLine[] = [
      {
        accountCode: ACCOUNTS.SELCOM_CLEARING,
        direction: 'DEBIT' as const,
        amount: input.netAmount,
        referenceType: 'ConductorPayout',
        referenceId: input.payoutId,
      },
      {
        accountCode: ACCOUNTS.CONDUCTOR_EARNINGS,
        direction: 'CREDIT' as const,
        amount: input.netAmount + input.fee,
        referenceType: 'ConductorPayout',
        referenceId: input.payoutId,
      },
    ]
    if (input.fee > 0) {
      entries.unshift({
        accountCode: ACCOUNTS.WITHDRAWAL_FEE_REVENUE,
        direction: 'DEBIT',
        amount: input.fee,
        referenceType: 'ConductorPayout',
        referenceId: input.payoutId,
      })
    }
    return this.ledger.post(tx, {
      reference: `PAYOUT-REVERSAL-${input.payoutId}`,
      type: 'CONDUCTOR_PAYOUT_REVERSED',
      description: `Reversal of payout ${input.payoutId}`,
      entries,
    })
  }

  private async expenseCommission(
    tx: Prisma.TransactionClient,
    reference: string,
    amount: number,
    referenceType: string,
    referenceId: string,
  ) {
    await this.ledger.post(tx, {
      reference,
      type: 'WAKALA_COMMISSION',
      description: `Wakala commission ${amount}`,
      entries: [
        {
          accountCode: ACCOUNTS.WAKALA_COMMISSION_EXPENSE,
          direction: 'DEBIT',
          amount,
          referenceType,
          referenceId,
        },
        {
          accountCode: ACCOUNTS.OPERATING,
          direction: 'CREDIT',
          amount,
          referenceType,
          referenceId,
        },
      ],
    })
  }

  private async numberPolicy(
    db: Prisma.TransactionClient | PrismaService,
    code: string,
    fallback: number,
  ) {
    const row = await db.pricingPolicy.findUnique({ where: { code } })
    const value = row ? Number((row.config as { amount?: number }).amount) : fallback
    return Number.isInteger(value) ? value : fallback
  }

  private async tierPolicy(db: Prisma.TransactionClient | PrismaService) {
    const row = await db.pricingPolicy.findUnique({ where: { code: 'CONDUCTOR_WITHDRAWAL_FEE' } })
    const tiers = row ? (row.config as { tiers?: WithdrawalFeeTier[] }).tiers : undefined
    return tiers?.length ? tiers : undefined
  }

  private async topUpPolicy(db: Prisma.TransactionClient | PrismaService) {
    const row = await db.pricingPolicy.findUnique({ where: { code: 'WAKALA_TOPUP_COMMISSION' } })
    const config = row?.config as { rateBps?: number; cap?: number } | undefined
    return {
      rateBps: config?.rateBps ?? 100,
      cap: config?.cap ?? 500,
    }
  }
}

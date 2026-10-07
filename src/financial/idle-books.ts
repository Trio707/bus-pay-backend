import type { BooksService } from './books.service'

/** Test stand-in. It does not post a ledger and it does not charge a fee. */
export function idleBooks(): BooksService {
  return {
    splitFare: async (_db: unknown, fare: number) => ({
      fare,
      platformFee: 0,
      conductorShare: fare,
      rateBps: 0,
    }),
    quoteWithdrawal: async (amount: number) => ({
      fee: 0,
      tier: 'test',
      currency: 'TZS' as const,
      netAmount: amount,
      totalDebit: amount,
    }),
    postFare: async () => ({ replay: false }),
    postTopUp: async () => ({ commission: 0 }),
    postRegistration: async () => ({ commission: 0 }),
    postRenewal: async () => ({ commission: 0 }),
    postCashOut: async () => ({ replay: false }),
    postPayoutCompleted: async () => ({ replay: false }),
    reversePayout: async () => ({ replay: false }),
    postMobileDeposit: async () => ({ replay: false }),
    reverseMobileDeposit: async () => ({ replay: false }),
  } as unknown as BooksService
}

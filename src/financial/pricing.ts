export type WithdrawalFeeTier = {
  minInclusive: number
  maxExclusive: number | null
  fee: number
}

/** Boundaries are inclusive on the lower side and exclusive on the upper side. */
export const DEFAULT_WITHDRAWAL_TIERS: WithdrawalFeeTier[] = [
  { minInclusive: 0, maxExclusive: 50_000, fee: 1_400 },
  { minInclusive: 50_000, maxExclusive: 100_000, fee: 2_100 },
  { minInclusive: 100_000, maxExclusive: 200_000, fee: 3_500 },
  { minInclusive: 200_000, maxExclusive: 300_000, fee: 4_000 },
  { minInclusive: 300_000, maxExclusive: 500_000, fee: 5_000 },
  { minInclusive: 500_000, maxExclusive: 1_000_000, fee: 7_000 },
  { minInclusive: 1_000_000, maxExclusive: null, fee: 10_000 },
]

export type FareSplit = {
  fare: number
  platformFee: number
  conductorShare: number
  rateBps: number
}

/**
 * BusPay keeps floor(fare * rate / 10000). 500 bps is 5%.
 * conductorShare + platformFee is always the full fare.
 */
export function splitFare(fare: number, rateBps = 500): FareSplit {
  assertWholeAmount(fare)
  const platformFee = Math.floor((fare * rateBps) / 10_000)
  return {
    fare,
    platformFee,
    conductorShare: fare - platformFee,
    rateBps,
  }
}

export type WithdrawalQuote = {
  fee: number
  tier: string
  currency: 'TZS'
  netAmount: number
  totalDebit: number
}

export function calculateConductorWithdrawalFee(
  amount: number,
  tiers: WithdrawalFeeTier[] = DEFAULT_WITHDRAWAL_TIERS,
): WithdrawalQuote {
  assertWholeAmount(amount)
  const tier = tiers.find(
    (row) => amount >= row.minInclusive && (row.maxExclusive == null || amount < row.maxExclusive),
  )
  if (!tier) {
    throw new Error('No withdrawal fee tier matches this amount')
  }
  const label =
    tier.maxExclusive == null
      ? `>= ${tier.minInclusive}`
      : `${tier.minInclusive} <= amount < ${tier.maxExclusive}`
  return {
    fee: tier.fee,
    tier: label,
    currency: 'TZS',
    netAmount: amount,
    totalDebit: amount + tier.fee,
  }
}

export function calculateWakalaTopUpCommission(
  amount: number,
  policy: { rateBps: number; cap: number } = { rateBps: 100, cap: 500 },
) {
  assertWholeAmount(amount)
  const raw = Math.floor((amount * policy.rateBps) / 10_000)
  return {
    commission: Math.min(policy.cap, raw),
    rateBps: policy.rateBps,
    cap: policy.cap,
  }
}

export function registrationCommission(flatAmount = 200) {
  return flatAmount
}

export function renewalCommission(flatAmount = 0) {
  return flatAmount
}

export function assertWholeAmount(amount: number) {
  if (!Number.isInteger(amount) || amount < 1) {
    throw new Error('Amount must be a positive whole number of TZS')
  }
}

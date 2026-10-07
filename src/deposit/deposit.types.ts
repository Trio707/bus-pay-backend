export const MOBILE_MONEY_NETWORKS = [
  'MPESA',
  'AIRTEL_MONEY',
  'MIXX_BY_YAS',
  'HALOPESA',
  'OTHER',
] as const

export type MobileMoneyNetworkName = (typeof MOBILE_MONEY_NETWORKS)[number]

export const DEPOSIT_CALLBACK_STATUSES = [
  'PENDING',
  'PROCESSING',
  'UNKNOWN',
  'COMPLETED',
  'FAILED',
  'REVERSED',
] as const

export type DepositCallbackStatus = (typeof DEPOSIT_CALLBACK_STATUSES)[number]

/** A callback BusPay has already authenticated. The client cannot produce this. */
export type VerifiedDepositCallback = {
  provider: string
  providerReference: string
  walletAccount: string
  amount: number
  network: MobileMoneyNetworkName
  status: DepositCallbackStatus
  customerPhone?: string
  failureReason?: string
}

export type DepositOpenResult =
  | { outcome: 'ACCEPTED'; providerReference: string }
  | { outcome: 'REJECTED'; reason: string }
  | { outcome: 'UNKNOWN' }

export interface DepositProvider {
  readonly name: string
  readonly configured: boolean
  /** Always false until an official provider adapter moves real money. */
  readonly liveMoney: false
  openCollection(input: {
    walletAccount: string
    amount: number
    network: string
  }): Promise<DepositOpenResult>
}

export const DEPOSIT_PROVIDER = Symbol('DEPOSIT_PROVIDER')

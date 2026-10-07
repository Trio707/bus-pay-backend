import type { DepositOpenResult, DepositProvider } from '../deposit.types'

/**
 * Selcom is the intended payment rail. This class does not call Selcom.
 * Official URLs, authentication, payloads, signatures, and operator menu codes are not in the project.
 * This class does not run a USSD session and does not accept a mobile-money PIN.
 */
export class SelcomDepositProvider implements DepositProvider {
  readonly name = 'selcom'
  readonly configured = false
  readonly liveMoney = false as const

  async openCollection(): Promise<DepositOpenResult> {
    return {
      outcome: 'REJECTED',
      reason:
        'Selcom is not connected. Official API documentation is required before a wallet can be funded.',
    }
  }
}

export class ClosedDepositProvider implements DepositProvider {
  readonly name = 'closed'
  readonly configured = false
  readonly liveMoney = false as const

  constructor(private readonly reason: string) {}

  async openCollection(): Promise<DepositOpenResult> {
    return { outcome: 'REJECTED', reason: this.reason }
  }
}

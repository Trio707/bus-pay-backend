import { randomInt } from 'node:crypto'

import type { DepositOpenResult, DepositProvider } from '../deposit.types'

/**
 * Sandbox rail. openCollection never reports a completed payment.
 * A wallet changes only when a signed sandbox callback is accepted.
 */
export class MockDepositProvider implements DepositProvider {
  readonly name = 'mock'
  readonly configured = true
  readonly liveMoney = false as const

  async openCollection(): Promise<DepositOpenResult> {
    return {
      outcome: 'ACCEPTED',
      providerReference: `sandbox-${randomInt(100000, 999999)}`,
    }
  }
}

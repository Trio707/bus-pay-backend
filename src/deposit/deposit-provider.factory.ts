import { ClosedDepositProvider } from './providers/selcom-deposit.provider'
import { MockDepositProvider } from './providers/mock-deposit.provider'
import { SelcomDepositProvider } from './providers/selcom-deposit.provider'
import type { DepositProvider } from './deposit.types'

export function createConfiguredDepositProvider(): DepositProvider {
  const selected = (process.env.DEPOSIT_PROVIDER ?? 'mock').trim().toLowerCase()
  if (selected === 'selcom') return new SelcomDepositProvider()
  if (process.env.NODE_ENV === 'production') {
    return new ClosedDepositProvider('Sandbox deposits are disabled in production.')
  }
  if (selected === '' || selected === 'mock') return new MockDepositProvider()
  return new ClosedDepositProvider('Deposit provider is not available.')
}

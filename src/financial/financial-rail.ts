import { ServiceUnavailableException } from '@nestjs/common';

import { SelcomPayoutProvider } from './selcom/selcom.provider';
import {
  MockPayoutProvider,
  type PayoutProvider,
  type PayoutProviderResult,
  type ProviderReportedStatus,
} from '../payout/payout-provider';

class UnavailablePayoutProvider implements PayoutProvider {
  readonly configured = false;

  async createPayout(): Promise<PayoutProviderResult> {
    return {
      outcome: 'REJECTED',
      reason: 'External payout provider is not connected.',
    };
  }

  async getPayoutStatus(): Promise<ProviderReportedStatus> {
    throw new ServiceUnavailableException('External payout provider is not connected.');
  }
}

export type LedgerStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'REVERSED';
export type ReportedProviderStatus = 'PROCESSING' | 'COMPLETED' | 'FAILED';
export type ReconciliationResult = 'MATCH' | 'MISMATCH' | 'UNKNOWN';

/** BusPay identity stays separate from the provider reference. */
export type ExternalTransactionView = {
  busPayReference: string;
  providerReference: string | null;
  type: 'CONDUCTOR_PAYOUT';
  amount: number;
  direction: 'OUTBOUND';
  destinationProvider: string;
  destination: string;
  method: string;
  status: string;
  createdAt: Date | string;
  completedAt: Date | string | null;
};

export function createConfiguredPayoutProvider(): PayoutProvider {
  const selected = (process.env.PAYOUT_PROVIDER ?? 'mock').trim().toLowerCase();
  if (selected === 'selcom') return new SelcomPayoutProvider();
  if (selected === '' || selected === 'mock') return new MockPayoutProvider();
  return new UnavailablePayoutProvider();
}

export function financialRailStatus() {
  const selected = (process.env.PAYOUT_PROVIDER ?? 'mock').trim().toLowerCase();
  const selcomSelected = selected === 'selcom';
  const mockSelected = selected === '' || selected === 'mock';
  return {
    intendedPartner: 'Selcom',
    activeAdapter: selcomSelected ? 'selcom' : mockSelected ? 'mock' : 'unavailable',
    selcomConfigured: false,
    liveMoneyMovement: false,
    environment: null,
    lastCallbackAt: null,
    lastSuccessfulExternalTransactionAt: null,
    reason: selcomSelected
      ? 'Selcom is selected, but its official API is not implemented. Payouts are refused and no funds are reserved.'
      : 'The sandbox adapter is active. It does not send money. Selcom is not connected.',
  };
}

export function toExternalTransaction(row: {
  reference: string;
  providerReference: string | null;
  amount: number;
  method: string;
  provider: string;
  destination: string;
  status: string;
  requestedAt: Date | string;
  completedAt: Date | string | null;
}): ExternalTransactionView {
  return {
    busPayReference: row.reference,
    providerReference: row.providerReference,
    type: 'CONDUCTOR_PAYOUT',
    amount: row.amount,
    direction: 'OUTBOUND',
    destinationProvider: row.provider,
    destination: row.destination,
    method: row.method,
    status: row.status,
    createdAt: row.requestedAt,
    completedAt: row.completedAt,
  };
}

/**
 * Compare a BusPay ledger status with a normalized provider status.
 * A missing provider status is unknown. It is not a match and not a settlement.
 */
export function reconcileExternalStatus(
  ledgerStatus: LedgerStatus,
  providerStatus: ReportedProviderStatus | null,
): ReconciliationResult {
  if (!providerStatus) return 'UNKNOWN';
  if (ledgerStatus === 'PENDING') return 'UNKNOWN';
  if (ledgerStatus === 'PROCESSING' && providerStatus === 'PROCESSING') return 'MATCH';
  if (ledgerStatus === 'COMPLETED' && providerStatus === 'COMPLETED') return 'MATCH';
  if (ledgerStatus === 'FAILED' && providerStatus === 'FAILED') return 'MATCH';
  if (ledgerStatus === 'REVERSED') return 'UNKNOWN';
  return 'MISMATCH';
}

/** Client-initiated digital top-up stays closed. A wallet is credited only from a verified deposit callback. */
export function requestPassengerDigitalTopUp(): never {
  throw new ServiceUnavailableException(
    'Passenger digital top-up is not available. A wallet is credited only after a verified Selcom transaction.',
  );
}

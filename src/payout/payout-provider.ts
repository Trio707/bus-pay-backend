export type PayoutMethodName = 'MOBILE_MONEY' | 'BANK';

export type PayoutRequest = {
  payoutId: string;
  reference: string;
  amount: number;
  method: PayoutMethodName;
  provider: string;
  destination: string;
  accountName?: string | null;
};

/** Local acceptance is not settlement. COMPLETED comes only from a verified callback. */
export type PayoutProviderResult =
  | { outcome: 'ACCEPTED'; providerReference: string }
  | { outcome: 'REJECTED'; reason: string }
  | { outcome: 'UNCERTAIN' };

export type ProviderReportedStatus = 'PROCESSING' | 'COMPLETED' | 'FAILED';

export interface PayoutProvider {
  /** False means BusPay must refuse the payout before reserving funds. */
  readonly configured: boolean;
  createPayout(request: PayoutRequest): Promise<PayoutProviderResult>;
  getPayoutStatus(providerReference: string): Promise<ProviderReportedStatus>;
}

export const PAYOUT_PROVIDER = Symbol('PAYOUT_PROVIDER');

/**
 * Sandbox adapter. It never moves real money and never reports COMPLETED.
 * A verified webhook is still required before a payout can settle.
 */
export class MockPayoutProvider implements PayoutProvider {
  readonly configured = true;

  async createPayout(request: PayoutRequest): Promise<PayoutProviderResult> {
    return {
      outcome: 'ACCEPTED',
      providerReference: `sandbox-${request.reference}`,
    };
  }

  async getPayoutStatus(): Promise<ProviderReportedStatus> {
    return 'PROCESSING';
  }
}

import { ServiceUnavailableException } from '@nestjs/common';

import {
  type PayoutProvider,
  type PayoutProviderResult,
  type PayoutRequest,
  type ProviderReportedStatus,
} from '../../payout/payout-provider';

/**
 * Selcom is the intended external rail. This class does not call Selcom.
 * Official request fields, signatures, and callback formats are not in the project.
 * It never accepts a payout and never reports a completed transfer.
 */
export class SelcomPayoutProvider implements PayoutProvider {
  readonly configured = false;

  async createPayout(_request: PayoutRequest): Promise<PayoutProviderResult> {
    return {
      outcome: 'REJECTED',
      reason:
        'Selcom is not connected. Official API documentation is required before any payout is sent.',
    };
  }

  async getPayoutStatus(_providerReference: string): Promise<ProviderReportedStatus> {
    throw new ServiceUnavailableException(
      'Selcom transaction status is not available.',
    );
  }
}

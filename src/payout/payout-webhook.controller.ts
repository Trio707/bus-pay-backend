import { Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

import { ConductorPayoutService } from './conductor-payout.service';

@Controller('webhooks/payouts')
export class PayoutWebhookController {
  constructor(private readonly payouts: ConductorPayoutService) {}

  @Post()
  @HttpCode(200)
  receive(@Req() req: RawBodyRequest<Request>) {
    return this.payouts.handleWebhook(
      req.rawBody,
      req.headers['x-buspay-payout-signature'],
    );
  }
}

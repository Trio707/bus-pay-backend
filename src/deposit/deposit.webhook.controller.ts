import { Controller, HttpCode, Param, Post, Req } from '@nestjs/common'
import type { RawBodyRequest } from '@nestjs/common'
import type { Request } from 'express'
import { DepositWebhookService } from './deposit.webhook.service'

@Controller('webhooks/deposits')
export class DepositWebhookController {
  constructor(private readonly webhooks: DepositWebhookService) {}

  @Post(':provider')
  @HttpCode(200)
  receive(
    @Param('provider') provider: string,
    @Req() req: RawBodyRequest<Request>,
  ) {
    return this.webhooks.receive(
      provider,
      req.rawBody,
      req.headers['x-buspay-deposit-signature'],
    )
  }
}

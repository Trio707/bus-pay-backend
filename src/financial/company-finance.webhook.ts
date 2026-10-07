import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  HttpCode,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common'
import type { RawBodyRequest } from '@nestjs/common'
import type { Request } from 'express'
import { CompanyFinanceService } from './company-finance.service'

@Controller('webhooks/company-finance')
export class CompanyFinanceWebhookController {
  constructor(private readonly company: CompanyFinanceService) {}

  @Post(':provider')
  @HttpCode(200)
  receive(@Param('provider') provider: string, @Req() req: RawBodyRequest<Request>) {
    return receiveCompanyCallback(
      this.company,
      provider,
      req.rawBody,
      req.headers['x-buspay-company-signature'],
    )
  }
}

export async function receiveCompanyCallback(
  company: CompanyFinanceService,
  providerName: string,
  rawBody: Buffer | undefined,
  signature: unknown,
) {
  const name = providerName.trim().toLowerCase()
  if (name === 'selcom' || name !== 'mock') {
    throw new ServiceUnavailableException(
      'Company payout provider is not connected. No transfer was completed.',
    )
  }
  if (process.env.NODE_ENV === 'production') {
    throw new ServiceUnavailableException('Sandbox company callbacks are disabled in production.')
  }
  const secret = process.env.COMPANY_FINANCE_WEBHOOK_SECRET?.trim() ?? ''
  if (!secret) throw new ServiceUnavailableException('Company finance webhook is not configured')
  if (!rawBody?.length) throw new BadRequestException('Empty company callback')
  const given = typeof signature === 'string' ? signature.trim() : ''
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  const left = Buffer.from(given)
  const right = Buffer.from(expected)
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new ForbiddenException('Invalid company callback signature')
  }
  let body: Record<string, unknown>
  try {
    body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>
  } catch {
    throw new BadRequestException('Invalid company callback')
  }
  assertNoSecret(body)
  const transactionId = typeof body.transactionId === 'string' ? body.transactionId.trim() : ''
  const providerReference = typeof body.providerReference === 'string' ? body.providerReference.trim() : ''
  const status = typeof body.status === 'string' ? body.status.trim().toUpperCase() : ''
  if (!transactionId || !providerReference || (status !== 'COMPLETED' && status !== 'FAILED' && status !== 'REVERSED')) {
    throw new BadRequestException('Invalid company callback')
  }
  return company.applyVerifiedCallback({ transactionId, providerReference, status })
}

function assertNoSecret(value: unknown): void {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(pin|mobilemoneypin|password|secret|apikey)$/i.test(key.replace(/[^a-z]/gi, ''))) {
      throw new BadRequestException('Secrets are not accepted on a company callback')
    }
    assertNoSecret(child)
  }
}

import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common'
import { DepositService } from './deposit.service'
import {
  DEPOSIT_CALLBACK_STATUSES,
  DEPOSIT_PROVIDER,
  MOBILE_MONEY_NETWORKS,
  type DepositCallbackStatus,
  type DepositProvider,
  type MobileMoneyNetworkName,
  type VerifiedDepositCallback,
} from './deposit.types'

@Injectable()
export class DepositWebhookService {
  constructor(
    private readonly deposits: DepositService,
    @Inject(DEPOSIT_PROVIDER) private readonly provider: DepositProvider,
  ) {}

  async receive(providerName: string, rawBody: Buffer | undefined, signature: unknown) {
    const name = providerName.trim().toLowerCase()
    if (name === 'selcom' || !this.provider.configured || this.provider.liveMoney) {
      throw new ServiceUnavailableException(
        'Selcom is not connected. No wallet was credited.',
      )
    }
    if (name !== 'mock' || this.provider.name !== 'mock') {
      throw new BadRequestException('Unknown deposit provider')
    }

    const secret = process.env.DEPOSIT_WEBHOOK_SECRET?.trim() ?? ''
    if (!secret) {
      throw new ServiceUnavailableException('Deposit webhook is not configured')
    }
    if (!rawBody?.length) throw new BadRequestException('Empty deposit callback')
    assertSignature(rawBody, signature, secret)

    let body: Record<string, unknown>
    try {
      body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>
    } catch {
      throw new BadRequestException('Invalid deposit callback')
    }
    assertNoOperatorSecret(body)
    return this.deposits.applyVerifiedCallback(parseCallback(body))
  }
}

function parseCallback(body: Record<string, unknown>): VerifiedDepositCallback {
  const providerReference = typeof body.providerReference === 'string' ? body.providerReference.trim() : ''
  const walletAccount = typeof body.walletAccount === 'string' ? body.walletAccount.trim() : ''
  const network = typeof body.network === 'string' ? body.network.trim().toUpperCase() : ''
  const status = typeof body.status === 'string' ? body.status.trim().toUpperCase() : ''
  const amount = typeof body.amount === 'number' ? body.amount : Number.NaN
  if (
    !providerReference ||
    !walletAccount ||
    !isNetwork(network) ||
    !isStatus(status) ||
    !Number.isInteger(amount)
  ) {
    throw new BadRequestException('Invalid deposit callback')
  }
  const customerPhone = typeof body.customerPhone === 'string' ? body.customerPhone : undefined
  const failureReason = typeof body.failureReason === 'string' ? body.failureReason : undefined
  return {
    provider: 'mock',
    providerReference,
    walletAccount,
    amount,
    network,
    status,
    customerPhone,
    failureReason,
  }
}

function assertSignature(raw: Buffer, signature: unknown, secret: string) {
  const given = typeof signature === 'string' ? signature.trim() : ''
  const expected = createHmac('sha256', secret).update(raw).digest('hex')
  const left = Buffer.from(given)
  const right = Buffer.from(expected)
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new ForbiddenException('Invalid deposit callback signature')
  }
}

function isNetwork(value: string): value is MobileMoneyNetworkName {
  return (MOBILE_MONEY_NETWORKS as readonly string[]).includes(value)
}

function isStatus(value: string): value is DepositCallbackStatus {
  return (DEPOSIT_CALLBACK_STATUSES as readonly string[]).includes(value)
}

const SECRET_KEY = /^(pin|mobilemoneypin|ussdpin|mpin)$/i

function assertNoOperatorSecret(value: unknown): void {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key.replace(/[^a-z]/gi, ''))) {
      throw new BadRequestException('Mobile-money PIN is not accepted')
    }
    assertNoOperatorSecret(child)
  }
}

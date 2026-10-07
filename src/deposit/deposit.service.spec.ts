import { createHmac } from 'node:crypto'
import { Logger } from '@nestjs/common'
import { PATH_METADATA } from '@nestjs/common/constants'
import { BadRequestException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { CardStatus, UserStatus, WalletStatus } from '../generated/prisma'
import { BooksService } from '../financial/books.service'
import { requestPassengerDigitalTopUp } from '../financial/financial-rail'
import { DepositService } from './deposit.service'
import { createConfiguredDepositProvider } from './deposit-provider.factory'
import { DepositWebhookController } from './deposit.webhook.controller'
import { DepositWebhookService } from './deposit.webhook.service'
import { MockDepositProvider } from './providers/mock-deposit.provider'
import { SelcomDepositProvider } from './providers/selcom-deposit.provider'

type Card = {
  id: string
  serialNumber: string
  nfcUid: string
  status: string
  walletId: string
}

function harness(balance = 5_000) {
  const wallets = [
    {
      id: 'wal-1',
      publicCode: '123456789012',
      customerId: 'cus-1',
      balance,
      status: WalletStatus.ACTIVE,
      customer: {
        id: 'cus-1',
        firstName: 'John',
        lastName: 'Mwangi',
        phone: '+255712345678',
        status: UserStatus.ACTIVE,
      },
    },
  ]
  const cards: Card[] = [
    {
      id: 'card-old',
      serialNumber: '123456789012',
      nfcUid: 'OLD',
      status: CardStatus.ACTIVE,
      walletId: 'wal-1',
    },
  ]
  const deposits: Array<Record<string, any>> = []
  const topUps: Array<Record<string, any>> = []
  const ledger: Array<Record<string, unknown>> = []
  const messages: string[] = []
  let floatBalance = 50_000
  let conductorEarnings = 20_000
  let chain = Promise.resolve()

  const tx = {
    $executeRaw: jest.fn(async () => 0),
    $queryRaw: jest.fn(async () => []),
    wallet: {
      findFirst: jest.fn(async ({ where }: { where: { publicCode: { equals: string } } }) => {
        return (
          wallets.find(
            (wallet) => wallet.publicCode.toLowerCase() === where.publicCode.equals.toLowerCase(),
          ) ?? null
        )
      }),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        return wallets.find((wallet) => wallet.id === where.id) ?? null
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: { balance: { increment?: number; decrement?: number } } }) => {
        const wallet = wallets.find((item) => item.id === where.id)
        if (!wallet) throw new Error('missing wallet')
        if (data.balance.increment) wallet.balance += data.balance.increment
        if (data.balance.decrement) wallet.balance -= data.balance.decrement
        return { ...wallet }
      }),
    },
    card: {
      findFirst: jest.fn(async ({ where }: { where: { walletId: string; status: string } }) => {
        return cards.find((card) => card.walletId === where.walletId && card.status === where.status) ?? null
      }),
    },
    topUp: {
      findUnique: jest.fn(async ({ where }: { where: { reference?: string } }) => {
        return topUps.find((row) => row.reference === where.reference) ?? null
      }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `tu-${topUps.length + 1}`, ...data }
        topUps.push(row)
        return row
      }),
    },
    walletDeposit: {
      findUnique: jest.fn(async ({ where }: { where: { id?: string; providerReference?: string; reference?: string } }) => {
        return (
          deposits.find((row) => {
            if (where.id) return row.id === where.id
            if (where.providerReference) return row.providerReference === where.providerReference
            if (where.reference) return row.reference === where.reference
            return false
          }) ?? null
        )
      }),
      create: jest.fn(async ({ data }: { data: Record<string, any> }) => {
        if (deposits.some((row) => row.providerReference === data.providerReference)) {
          throw Object.assign(new Error('unique'), { code: 'P2002' })
        }
        const row = {
          id: `dep-${deposits.length + 1}`,
          failureReason: null,
          topUpId: null,
          requestedAt: new Date(),
          processingAt: null,
          completedAt: null,
          failedAt: null,
          reversedAt: null,
          createdAt: new Date(),
          ...data,
        }
        deposits.push(row)
        return row
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = deposits.find((item) => item.id === where.id)
        if (!row) throw new Error('missing deposit')
        Object.assign(row, data)
        return row
      }),
    },
  }

  const prisma = {
    $transaction: jest.fn((fn: (client: typeof tx) => Promise<unknown>) => {
      const run = chain.then(() => fn(tx))
      chain = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    }),
    topUp: {
      findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        return topUps.filter((row) => where.id.in.includes(String(row.id)))
      }),
    },
    walletDeposit: {
      count: jest.fn(async ({ where }: { where?: { status?: string } } = {}) => {
        return deposits.filter((row) => !where?.status || row.status === where.status).length
      }),
      findMany: jest.fn(async ({ where }: { where?: { status?: string } } = {}) => {
        return deposits
          .filter((row) => !where?.status || row.status === where.status)
          .map((row) => ({
            ...row,
            wallet: {
              ...wallets[0],
              cards,
            },
          }))
      }),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const row = deposits.find((item) => item.id === where.id)
        if (!row) return null
        return { ...row, wallet: { ...wallets[0], cards } }
      }),
    },
  }

  const books = {
    postMobileDeposit: jest.fn(async (_tx: unknown, input: { depositId: string; amount: number }) => {
      ledger.push({
        reference: `DEPOSIT-${input.depositId}`,
        type: 'MOBILE_MONEY_DEPOSIT',
        debit: '7000',
        credit: '1000',
        amount: input.amount,
        revenue: 0,
        float: 0,
      })
      return { replay: false }
    }),
    reverseMobileDeposit: jest.fn(async (_tx: unknown, input: { depositId: string; amount: number }) => {
      ledger.push({
        reference: `DEPOSIT-REVERSAL-${input.depositId}`,
        type: 'MOBILE_MONEY_DEPOSIT_REVERSED',
        amount: input.amount,
      })
      return { replay: false }
    }),
  }
  const enqueue = jest.fn(async (_phone: string, _type: string, message: string) => {
    messages.push(message)
  })
  const service = new DepositService(prisma as never, books as never, { enqueue } as never)

  function collectFare(card: Card, amount: number) {
    if (card.status !== CardStatus.ACTIVE) {
      throw new BadRequestException('Card cannot be used')
    }
    const wallet = wallets[0]
    if (wallet.balance < amount) throw new BadRequestException('Insufficient balance')
    wallet.balance -= amount
    conductorEarnings += amount
    return wallet.balance
  }

  function wakalaCashTopUp(amount: number) {
    if (floatBalance < amount) throw new BadRequestException('Float is too low')
    floatBalance -= amount
    wallets[0].balance += amount
    topUps.push({ source: 'AGENT_TOPUP', amount })
  }

  async function paid(network: string, amount: number, providerReference: string, extra: Record<string, unknown> = {}) {
    return service.applyVerifiedCallback({
      provider: 'mock',
      providerReference,
      walletAccount: '123456789012',
      amount,
      network: network as 'MPESA',
      status: 'COMPLETED',
      ...extra,
    })
  }

  return {
    service,
    wallets,
    cards,
    deposits,
    topUps,
    ledger,
    messages,
    books,
    enqueue,
    collectFare,
    wakalaCashTopUp,
    paid,
    get floatBalance() {
      return floatBalance
    },
    get conductorEarnings() {
      return conductorEarnings
    },
  }
}

describe('direct passenger mobile-money funding', () => {
  it('credits M-Pesa, Airtel Money, Mixx by Yas, and HaloPesa into the same wallet', async () => {
    const world = harness()
    await world.paid('MPESA', 10_000, 'mpesa-1')
    await world.paid('AIRTEL_MONEY', 2_000, 'airtel-1')
    await world.paid('MIXX_BY_YAS', 3_000, 'mixx-1')
    await world.paid('HALOPESA', 4_000, 'halo-1')
    expect(world.wallets[0].balance).toBe(24_000)
    expect(world.deposits.map((row) => row.mobileMoneyNetwork)).toEqual([
      'MPESA',
      'AIRTEL_MONEY',
      'MIXX_BY_YAS',
      'HALOPESA',
    ])
    expect(world.topUps).toHaveLength(4)
    expect(world.topUps.every((row) => row.source === 'MOBILE_MONEY')).toBe(true)
    expect(world.ledger).toHaveLength(4)
    expect(world.ledger.every((row) => row.debit === '7000' && row.credit === '1000' && row.revenue === 0)).toBe(true)
    expect(world.floatBalance).toBe(50_000)
  })

  it('raises a 5,000 wallet to 15,000 and lets the same balance pay a fare', async () => {
    const world = harness(5_000)
    const credited = await world.paid('MPESA', 10_000, 'abc123')
    expect(credited.wallet.balance).toBe(15_000)
    expect(world.wallets[0].balance).toBe(15_000)
    expect(world.collectFare(world.cards[0], 700)).toBe(14_300)
    expect(world.wallets[0].balance).toBe(14_300)
    expect(world.conductorEarnings).toBe(20_700)
  })

  it('shows the completed deposit to admin with a masked phone and the live wallet balance', async () => {
    const world = harness(5_000)
    const credited = await world.paid('MPESA', 10_000, 'abc123')
    const listed = await world.service.listForAdmin()
    const opened = await world.service.getForAdmin(credited.id)
    expect(listed.deposits[0]).toMatchObject({
      passenger: 'JOHN MWANGI',
      phone: '07******78',
      walletAccount: '123456789012',
      cardSerial: '123456789012',
      channel: 'MOBILE_MONEY',
      source: 'USSD_OPERATOR_PAYMENT',
      amount: 10_000,
      network: 'MPESA',
      provider: 'mock',
      providerReference: 'abc123',
      status: 'COMPLETED',
      balanceAfterPayment: 15_000,
      walletBalance: 15_000,
    })
    expect(opened.deposit.walletBalance).toBe(15_000)
    expect(opened.selcomConnected).toBe(false)
    expect(opened.liveMoney).toBe(false)
    expect(JSON.stringify(listed)).not.toContain('+255712345678')
  })

  it('does not credit twice when the same callback is repeated or arrives together', async () => {
    const world = harness(5_000)
    const first = await world.paid('MPESA', 10_000, 'abc123')
    const second = await world.paid('MPESA', 10_000, 'abc123')
    const [left, right] = await Promise.all([
      world.paid('AIRTEL_MONEY', 1_000, 'once'),
      world.paid('AIRTEL_MONEY', 1_000, 'once'),
    ])
    expect(second.replay).toBe(true)
    expect(first.wallet.balance).toBe(15_000)
    expect(world.wallets[0].balance).toBe(16_000)
    expect([left.replay, right.replay].filter(Boolean)).toHaveLength(1)
    expect(world.messages).toHaveLength(2)
    expect(world.ledger).toHaveLength(2)
    expect(world.messages[0]).toContain('TZS 10,000')
    expect(world.messages[0]).toContain('Asante kwa kutumia BusPay.')
    expect(world.messages[0].startsWith('BusPay:')).toBe(false)
  })

  it('rejects a bad callback, a phone mismatch, an unknown account, and a reversal with no deposit', async () => {
    const world = harness()
    await expect(
      world.service.applyVerifiedCallback({
        provider: 'mock',
        providerReference: '',
        walletAccount: '123456789012',
        amount: 1000,
        network: 'MPESA',
        status: 'COMPLETED',
      }),
    ).rejects.toBeInstanceOf(BadRequestException)
    await expect(
      world.paid('MPESA', 10_000, 'phone', { customerPhone: '+255700000000' }),
    ).rejects.toThrow('Phone does not match')
    await expect(
      world.service.applyVerifiedCallback({
        provider: 'mock',
        providerReference: 'missing-wallet',
        walletAccount: '000000000000',
        amount: 1000,
        network: 'MPESA',
        status: 'COMPLETED',
      }),
    ).rejects.toBeInstanceOf(NotFoundException)
    await expect(
      world.service.applyVerifiedCallback({
        provider: 'mock',
        providerReference: 'never-seen',
        walletAccount: '123456789012',
        amount: 1000,
        network: 'MPESA',
        status: 'REVERSED',
      }),
    ).rejects.toThrow('Invalid provider reference')
    expect(world.wallets[0].balance).toBe(5_000)
    expect(world.deposits).toHaveLength(0)
    expect(world.messages).toHaveLength(0)
  })

  it('leaves the wallet unchanged for failed, unknown, and processing payments', async () => {
    const world = harness()
    for (const status of ['FAILED', 'UNKNOWN', 'PROCESSING', 'PENDING'] as const) {
      const result = await world.service.applyVerifiedCallback({
        provider: 'mock',
        providerReference: `state-${status}`,
        walletAccount: '123456789012',
        amount: 10_000,
        network: 'OTHER',
        status,
      })
      expect(result.status).toBe(status)
      expect(result.wallet.balance).toBe(5_000)
    }
    expect(world.wallets[0].balance).toBe(5_000)
    expect(world.topUps).toHaveLength(0)
    expect(world.ledger).toHaveLength(0)
    expect(world.messages).toHaveLength(0)
    const completed = await world.service.applyVerifiedCallback({
      provider: 'mock',
      providerReference: 'state-UNKNOWN',
      walletAccount: '123456789012',
      amount: 10_000,
      network: 'OTHER',
      status: 'COMPLETED',
    })
    expect(completed.wallet.balance).toBe(15_000)
    expect(world.messages).toHaveLength(1)
  })

  it('keeps the wallet through card replacement and blocks the lost card', async () => {
    const world = harness(10_000)
    const lost = world.cards[0]
    lost.status = CardStatus.LOST
    world.cards.push({
      id: 'card-new',
      serialNumber: '123456789012',
      nfcUid: 'NEW',
      status: CardStatus.ACTIVE,
      walletId: 'wal-1',
    })
    await world.paid('MPESA', 5_000, 'after-replace')
    expect(world.wallets[0].id).toBe('wal-1')
    expect(world.wallets[0].balance).toBe(15_000)
    expect(world.topUps[0].cardId).toBe('card-new')
    expect(() => world.collectFare(lost, 700)).toThrow('Card cannot be used')
    expect(world.collectFare(world.cards[1], 700)).toBe(14_300)
    expect(world.wallets).toHaveLength(1)
  })

  it('still blocks a fare the wallet cannot pay, and still accepts wakala cash on the same wallet', async () => {
    const world = harness(500)
    expect(() => world.collectFare(world.cards[0], 700)).toThrow('Insufficient balance')
    expect(world.wallets[0].balance).toBe(500)
    world.wakalaCashTopUp(2_000)
    expect(world.wallets[0].balance).toBe(2_500)
    expect(world.floatBalance).toBe(48_000)
    await world.paid('MIXX_BY_YAS', 10_000, 'mix-float')
    expect(world.wallets[0].balance).toBe(12_500)
    expect(world.floatBalance).toBe(48_000)
    expect(world.conductorEarnings).toBe(20_000)
    expect(world.topUps.some((row) => row.source === 'AGENT_TOPUP')).toBe(true)
    expect(world.topUps.some((row) => row.source === 'MOBILE_MONEY')).toBe(true)
  })

  it('keeps one wallet balance when a fare and a mobile-money payment overlap', async () => {
    const world = harness(5_000)
    await Promise.all([
      world.paid('MPESA', 10_000, 'overlap'),
      Promise.resolve().then(() => world.collectFare(world.cards[0], 700)),
    ])
    expect(world.wallets[0].balance).toBe(14_300)
    expect(world.ledger).toHaveLength(1)
    expect(world.floatBalance).toBe(50_000)
  })

  it('reverses a completed deposit once and refuses a second credit from a failed row', async () => {
    const world = harness(5_000)
    await world.paid('HALOPESA', 1_000, 'rev-1')
    const reversed = await world.service.applyVerifiedCallback({
      provider: 'mock',
      providerReference: 'rev-1',
      walletAccount: '123456789012',
      amount: 1_000,
      network: 'HALOPESA',
      status: 'REVERSED',
    })
    expect(reversed.status).toBe('REVERSED')
    expect(world.wallets[0].balance).toBe(5_000)
    expect(world.ledger.some((row) => row.type === 'MOBILE_MONEY_DEPOSIT_REVERSED')).toBe(true)
    await world.service.applyVerifiedCallback({
      provider: 'mock',
      providerReference: 'stay-failed',
      walletAccount: '123456789012',
      amount: 9_000,
      network: 'MPESA',
      status: 'FAILED',
    })
    const stuck = await world.service.applyVerifiedCallback({
      provider: 'mock',
      providerReference: 'stay-failed',
      walletAccount: '123456789012',
      amount: 9_000,
      network: 'MPESA',
      status: 'COMPLETED',
    })
    expect(stuck.status).toBe('FAILED')
    expect(world.wallets[0].balance).toBe(5_000)
  })
})

describe('deposit provider boundary', () => {
  const nodeEnv = process.env.NODE_ENV
  const depositProvider = process.env.DEPOSIT_PROVIDER
  const webhookSecret = process.env.DEPOSIT_WEBHOOK_SECRET

  afterEach(() => {
    restoreEnv('NODE_ENV', nodeEnv)
    restoreEnv('DEPOSIT_PROVIDER', depositProvider)
    restoreEnv('DEPOSIT_WEBHOOK_SECRET', webhookSecret)
  })

  it('never reports a completed mock collection and refuses Selcom', async () => {
    const mock = new MockDepositProvider()
    const opened = await mock.openCollection({
      walletAccount: '123456789012',
      amount: 1000,
      network: 'MPESA',
    })
    expect(opened.outcome).not.toBe('COMPLETED')
    expect(mock.liveMoney).toBe(false)
    const selcom = new SelcomDepositProvider()
    expect(selcom.configured).toBe(false)
    const rejected = await selcom.openCollection({
      walletAccount: '123456789012',
      amount: 1000,
      network: 'MPESA',
    })
    expect(rejected.outcome).toBe('REJECTED')
  })

  it('disables the sandbox provider in production', () => {
    process.env.NODE_ENV = 'production'
    process.env.DEPOSIT_PROVIDER = 'mock'
    const provider = createConfiguredDepositProvider()
    expect(provider.configured).toBe(false)
    expect(provider.liveMoney).toBe(false)
  })

  it('rejects an unsigned callback and does not credit when Selcom is addressed', async () => {
    const apply = jest.fn()
    process.env.DEPOSIT_WEBHOOK_SECRET = 'sandbox-secret'
    const mockHooks = new DepositWebhookService({ applyVerifiedCallback: apply } as never, new MockDepositProvider())
    const raw = Buffer.from(JSON.stringify({ providerReference: 'x', walletAccount: '1', amount: 1, network: 'MPESA', status: 'COMPLETED' }))
    await expect(mockHooks.receive('mock', raw, 'deadbeef')).rejects.toBeInstanceOf(ForbiddenException)
    const selcomHooks = new DepositWebhookService(
      { applyVerifiedCallback: apply } as never,
      new SelcomDepositProvider(),
    )
    await expect(selcomHooks.receive('selcom', raw, 'anything')).rejects.toBeInstanceOf(ServiceUnavailableException)
    await expect(mockHooks.receive('mpesa', raw, sign(raw))).rejects.toBeInstanceOf(BadRequestException)
    expect(apply).not.toHaveBeenCalled()
    expect(() => requestPassengerDigitalTopUp()).toThrow('verified Selcom transaction')
  })

  it('refuses a mobile-money PIN and does not store or log it', async () => {
    process.env.DEPOSIT_WEBHOOK_SECRET = 'sandbox-secret'
    const secret = 'ZXQ-7781-PIN'
    const apply = jest.fn()
    const hooks = new DepositWebhookService({ applyVerifiedCallback: apply } as never, new MockDepositProvider())
    const raw = Buffer.from(
      JSON.stringify({
        providerReference: 'abc123',
        walletAccount: '123456789012',
        amount: 10_000,
        network: 'MPESA',
        status: 'COMPLETED',
        pin: secret,
        mobileMoneyPin: secret,
      }),
    )
    const logs: string[] = []
    const spy = jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      logs.push(String(message))
    })
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      logs.push(String(message))
    })
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => {
      logs.push(String(message))
    })
    await expect(hooks.receive('mock', raw, sign(raw))).rejects.toThrow('Mobile-money PIN is not accepted')
    expect(apply).not.toHaveBeenCalled()
    expect(logs.join(' ')).not.toContain(secret)
    spy.mockRestore()
    warn.mockRestore()
    error.mockRestore()
    expect(Reflect.getMetadata(PATH_METADATA, DepositWebhookController)).toBe('webhooks/deposits')
    expect(JSON.stringify(Reflect.getMetadata(PATH_METADATA, DepositWebhookController))).not.toContain('ussd')
  })

  it('accepts one signed sandbox callback', async () => {
    process.env.DEPOSIT_WEBHOOK_SECRET = 'sandbox-secret'
    const apply = jest.fn(async () => ({ received: true, status: 'COMPLETED' }))
    const hooks = new DepositWebhookService({ applyVerifiedCallback: apply } as never, new MockDepositProvider())
    const raw = Buffer.from(
      JSON.stringify({
        providerReference: 'abc123',
        walletAccount: '123456789012',
        amount: 10_000,
        network: 'MPESA',
        status: 'COMPLETED',
      }),
    )
    await hooks.receive('mock', raw, sign(raw))
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('posts a deposit as clearing against passenger wallets, not revenue', async () => {
    const posts: Array<{ type: string; entries: Array<{ accountCode: string; direction: string; amount: number }> }> = []
    const books = new BooksService(
      {} as never,
      { post: async (_tx: unknown, posting: (typeof posts)[number]) => { posts.push(posting); return { replay: false } } } as never,
      {} as never,
    )
    await books.postMobileDeposit({} as never, { depositId: 'dep-1', amount: 10_000 })
    expect(posts[0].type).toBe('MOBILE_MONEY_DEPOSIT')
    expect(posts[0].entries).toEqual([
      expect.objectContaining({ accountCode: '7000', direction: 'DEBIT', amount: 10_000 }),
      expect.objectContaining({ accountCode: '1000', direction: 'CREDIT', amount: 10_000 }),
    ])
    expect(posts[0].entries.some((entry) => entry.accountCode.startsWith('4'))).toBe(false)
    expect(posts[0].entries.some((entry) => entry.accountCode === '3000')).toBe(false)
  })
})

function sign(raw: Buffer) {
  return createHmac('sha256', 'sandbox-secret').update(raw).digest('hex')
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

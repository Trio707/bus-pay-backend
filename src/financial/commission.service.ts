import { BadRequestException, Injectable } from '@nestjs/common'
import { CommissionType, type Prisma } from '../generated/prisma'
import { PrismaService } from '../prisma/prisma.service'

@Injectable()
export class CommissionService {
  constructor(private readonly prisma: PrismaService) {}

  async accrue(
    tx: Prisma.TransactionClient,
    input: {
      agentUserId: string
      type: CommissionType
      amount: number
      sourceType: string
      sourceId: string
    },
  ) {
    if (input.amount === 0) return { replay: false as const, amount: 0 }
    if (!Number.isInteger(input.amount) || input.amount < 0) {
      throw new BadRequestException('Commission must be a whole number of TZS')
    }
    const existing = await tx.wakalaCommissionEntry.findUnique({
      where: {
        sourceType_sourceId_type: {
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          type: input.type,
        },
      },
    })
    if (existing) return { replay: true as const, entry: existing, amount: existing.amount }

    const account = await tx.wakalaCommissionAccount.upsert({
      where: { agentUserId: input.agentUserId },
      create: { agentUserId: input.agentUserId },
      update: {},
    })
    const entry = await tx.wakalaCommissionEntry.create({
      data: {
        accountId: account.id,
        agentUserId: input.agentUserId,
        type: input.type,
        amount: input.amount,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        status: 'PENDING',
      },
    })
    await tx.wakalaCommissionAccount.update({
      where: { id: account.id },
      data: {
        balance: { increment: input.amount },
        totalEarned: { increment: input.amount },
      },
    })
    return { replay: false as const, entry, amount: input.amount }
  }

  /**
   * Marks pending commission as settled inside BusPay.
   * This does not call Selcom and does not send money.
   */
  async settle(tx: Prisma.TransactionClient, agentUserId: string, minimum = 0) {
    const pending = await tx.wakalaCommissionEntry.findMany({
      where: { agentUserId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    })
    const amount = pending.reduce((total, row) => total + row.amount, 0)
    if (amount < 1) return { settled: false as const, amount: 0 }
    if (amount < minimum) {
      throw new BadRequestException(
        `Commission TZS ${amount} is below the settlement minimum of TZS ${minimum}`,
      )
    }
    const settlement = await tx.wakalaCommissionSettlement.create({
      data: {
        reference: `WCS-${Date.now()}-${agentUserId.slice(0, 8)}`,
        agentUserId,
        amount,
        status: 'READY',
      },
    })
    await tx.wakalaCommissionEntry.updateMany({
      where: { id: { in: pending.map((row) => row.id) }, status: 'PENDING' },
      data: { status: 'SETTLED', settlementId: settlement.id },
    })
    await tx.wakalaCommissionAccount.update({
      where: { agentUserId },
      data: {
        balance: { decrement: amount },
        totalPaid: { increment: amount },
        lastSettledAt: new Date(),
      },
    })
    return { settled: true as const, amount, settlement }
  }
}

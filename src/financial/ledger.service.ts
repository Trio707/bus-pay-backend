import { BadRequestException, Injectable } from '@nestjs/common'
import {
  FinancialAccountType,
  LedgerDirection,
  type Prisma,
} from '../generated/prisma'
import { PrismaService } from '../prisma/prisma.service'

export type LedgerLine = {
  accountCode: string
  direction: 'DEBIT' | 'CREDIT'
  amount: number
  referenceType?: string
  referenceId?: string
  description?: string
}

export type LedgerPosting = {
  reference: string
  type: string
  description: string
  entries: LedgerLine[]
}

type AccountRow = {
  id: string
  accountCode: string
  type: FinancialAccountType
  allowNegative: boolean
  balance: number
  status: string
}

@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async post(tx: Prisma.TransactionClient, posting: LedgerPosting) {
    const existing = await tx.financialLedgerTransaction.findUnique({
      where: { transactionReference: posting.reference },
      include: { entries: true },
    })
    if (existing) return { replay: true as const, transaction: existing }

    const entries = posting.entries.filter((entry) => entry.amount !== 0)
    if (entries.length < 2) {
      throw new BadRequestException('A ledger transaction needs balanced entries')
    }
    for (const entry of entries) {
      if (!Number.isInteger(entry.amount) || entry.amount < 1) {
        throw new BadRequestException('Ledger amounts must be positive whole TZS')
      }
    }
    const debits = sum(entries, 'DEBIT')
    const credits = sum(entries, 'CREDIT')
    if (debits !== credits) {
      throw new BadRequestException('Ledger transaction does not balance')
    }

    const locked = await this.lockAccounts(tx, entries)
    const header = await tx.financialLedgerTransaction.create({
      data: {
        transactionReference: posting.reference,
        transactionType: posting.type,
        description: posting.description,
        status: 'POSTED',
      },
    })

    for (const entry of entries) {
      const account = locked.get(entry.accountCode)
      if (!account) {
        throw new BadRequestException(`Unknown financial account ${entry.accountCode}`)
      }
      if (account.status !== 'ACTIVE') {
        throw new BadRequestException(`Financial account ${entry.accountCode} is not active`)
      }
      const delta = signedDelta(account.type, entry.direction, entry.amount)
      const next = account.balance + delta
      if (!account.allowNegative && next < 0) {
        throw new BadRequestException(
          `Account ${account.accountCode} cannot go negative`,
        )
      }
      const updated = await tx.financialAccount.updateMany({
        where: { id: account.id, balance: account.balance },
        data: { balance: next },
      })
      if (updated.count !== 1) {
        throw new BadRequestException('Financial account changed. Retry the operation.')
      }
      account.balance = next
      await tx.financialLedgerEntry.create({
        data: {
          ledgerTransactionId: header.id,
          accountId: account.id,
          direction: entry.direction,
          amount: entry.amount,
          referenceType: entry.referenceType ?? null,
          referenceId: entry.referenceId ?? null,
          description: entry.description ?? null,
        },
      })
    }

    return { replay: false as const, transaction: header }
  }

  private async lockAccounts(tx: Prisma.TransactionClient, entries: LedgerLine[]) {
    const codes = [...new Set(entries.map((entry) => entry.accountCode))].sort()
    const locked = new Map<string, AccountRow>()
    for (const code of codes) {
      await tx.$queryRaw`
        SELECT "id" FROM "FinancialAccount" WHERE "accountCode" = ${code} FOR UPDATE
      `
      const account = await tx.financialAccount.findUnique({ where: { accountCode: code } })
      if (!account) {
        throw new BadRequestException(`Unknown financial account ${code}`)
      }
      locked.set(code, account)
    }
    return locked
  }
}

function sum(entries: LedgerLine[], direction: LedgerDirection) {
  return entries
    .filter((entry) => entry.direction === direction)
    .reduce((total, entry) => total + entry.amount, 0)
}

export function signedDelta(
  type: FinancialAccountType,
  direction: 'DEBIT' | 'CREDIT',
  amount: number,
) {
  const debitNormal = type === FinancialAccountType.ASSET || type === FinancialAccountType.EXPENSE
  if (debitNormal) return direction === 'DEBIT' ? amount : -amount
  return direction === 'CREDIT' ? amount : -amount
}

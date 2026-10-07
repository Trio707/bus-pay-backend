import { BadRequestException, Injectable } from '@nestjs/common';

import { normalizePhone, TZ_PHONE_PATTERN } from '../auth/identity';
import { Prisma } from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';

export type SmsType =
  | 'CARD_REGISTERED'
  | 'TOP_UP'
  | 'PAYMENT_TAP'
  | 'PAYMENT_TAP_CONDUCTOR'
  | 'CARD_RENEWED'
  | 'WALLET_REFUND'
  | 'WAKALA_FLOAT_FUNDING'
  | 'CONDUCTOR_WITHDRAWAL_SUCCESS'
  | 'WAKALA_WITHDRAWAL_RECEIVED'
  | 'WAKALA_ACCOUNT_CREDENTIALS'
  | 'CONDUCTOR_PAYOUT_PENDING'
  | 'CONDUCTOR_PAYOUT_COMPLETED'
  | 'CONDUCTOR_PAYOUT_FAILED'

type DbClient = Prisma.TransactionClient | PrismaService

@Injectable()
export class SmsService {
  constructor(private readonly prisma: PrismaService) {}

  async enqueue(
    phone: string,
    type: SmsType,
    message: string,
    db: DbClient = this.prisma,
  ) {
    const recipient = normalizePhone(phone);
    if (!TZ_PHONE_PATTERN.test(recipient)) {
      throw new BadRequestException(
        'Use a Tanzanian number like +255712345678',
      );
    }
    return db.smsOutbox.create({
      data: {
        phone: recipient,
        type,
        message,
        status: 'PENDING',
      },
    })
  }
}

import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { FinancialModule } from '../financial/financial.module'
import { PrismaModule } from '../prisma/prisma.module'
import { SmsModule } from '../sms/sms.module'
import { createConfiguredDepositProvider } from './deposit-provider.factory'
import { DEPOSIT_PROVIDER } from './deposit.types'
import { DepositAdminController } from './deposit.controller'
import { DepositService } from './deposit.service'
import { DepositWebhookController } from './deposit.webhook.controller'
import { DepositWebhookService } from './deposit.webhook.service'

@Module({
  imports: [PrismaModule, AuthModule, FinancialModule, SmsModule],
  controllers: [DepositAdminController, DepositWebhookController],
  providers: [
    DepositService,
    DepositWebhookService,
    { provide: DEPOSIT_PROVIDER, useFactory: createConfiguredDepositProvider },
  ],
  exports: [DepositService],
})
export class DepositModule {}

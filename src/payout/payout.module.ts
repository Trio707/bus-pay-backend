import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { FinancialModule } from '../financial/financial.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SmsModule } from '../sms/sms.module';
import { ConductorPayoutController } from './conductor-payout.controller';
import { ConductorPayoutService } from './conductor-payout.service';
import { PayoutWebhookController } from './payout-webhook.controller';
import { createConfiguredPayoutProvider } from '../financial/financial-rail';
import { PAYOUT_PROVIDER } from './payout-provider';

@Module({
  imports: [PrismaModule, AuthModule, SmsModule, FinancialModule],
  controllers: [ConductorPayoutController, PayoutWebhookController],
  providers: [
    ConductorPayoutService,
    { provide: PAYOUT_PROVIDER, useFactory: createConfiguredPayoutProvider },
  ],
  exports: [ConductorPayoutService],
})
export class PayoutModule {}

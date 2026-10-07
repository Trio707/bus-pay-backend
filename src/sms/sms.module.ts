import { Module, forwardRef } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { BeemSmsProvider } from './beem-sms.provider';
import { MockSmsProvider } from './mock-sms.provider';
import { SmsAdminController } from './sms-admin.controller';
import { SmsDispatcherService } from './sms-dispatcher.service';
import { SmsService } from './sms.service';
import { SwalaSmsProvider } from './swala-sms.provider';
import { SwalaWebhookController } from './swala-webhook.controller';
import { SwalaWebhookService } from './swala-webhook.service';

@Module({
  imports: [PrismaModule, forwardRef(() => AuthModule)],
  controllers: [SmsAdminController, SwalaWebhookController],
  providers: [
    BeemSmsProvider,
    MockSmsProvider,
    SwalaSmsProvider,
    SwalaWebhookService,
    SmsService,
    SmsDispatcherService,
  ],
  exports: [SmsService, SmsDispatcherService, BeemSmsProvider],
})
export class SmsModule {}

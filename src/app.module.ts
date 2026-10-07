import { Module } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthController } from './health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { PlatformModule } from './platform/platform.module';
import { AdminModule } from './admin/admin.module';
import { DepositModule } from './deposit/deposit.module';
import { PayoutModule } from './payout/payout.module';
import { ProfilePhotoModule } from './profile-photo/profile-photo.module';
import { EmailModule } from './email/email.module';
import { SmsModule } from './sms/sms.module';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

const observeAppKey = process.env.OBSERVE_APP_KEY;
const observeAppSecret = process.env.OBSERVE_APP_SECRET;
const observeImports =
  observeAppKey && observeAppSecret
    ? [
        ObserveModule.forRoot({
          appKey: observeAppKey,
          appSecret: observeAppSecret,
          serviceId: 'bus-pay-backend',
        }),
      ]
    : [];

@Module({
  imports: [
    PrismaModule,
    ...observeImports,
    AuthModule,
    PlatformModule,
    AdminModule,
    PayoutModule,
    DepositModule,
    SmsModule,
    EmailModule,
    ProfilePhotoModule,
  ],
  controllers: [AppController, HealthController],
  providers: [AppService],
})
export class AppModule {}

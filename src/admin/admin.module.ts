import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PlatformModule } from '../platform/platform.module';
import { PrismaModule } from '../prisma/prisma.module';
import { FinancialModule } from '../financial/financial.module';
import { PayoutModule } from '../payout/payout.module';
import { ProfilePhotoModule } from '../profile-photo/profile-photo.module';
import { EmailModule } from '../email/email.module';
import { SmsModule } from '../sms/sms.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [PrismaModule, AuthModule, SmsModule, EmailModule, PlatformModule, PayoutModule, FinancialModule, ProfilePhotoModule],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { FinancialModule } from '../financial/financial.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SmsModule } from '../sms/sms.module';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';
import { WakalaFloatService } from './wakala-float.service';

@Module({
  imports: [PrismaModule, AuthModule, SmsModule, FinancialModule],
  controllers: [PlatformController],
  providers: [PlatformService, WakalaFloatService],
  exports: [PlatformService, WakalaFloatService],
})
export class PlatformModule {}

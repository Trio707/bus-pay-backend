import { Module } from '@nestjs/common';

import { EmailService } from './email.service';
import { EMAIL_PROVIDER } from './email.types';
import { ResendEmailProvider } from './resend-email.provider';

@Module({
  providers: [
    {
      provide: ResendEmailProvider,
      useFactory: () => new ResendEmailProvider(),
    },
    { provide: EMAIL_PROVIDER, useExisting: ResendEmailProvider },
    EmailService,
  ],
  exports: [EmailService],
})
export class EmailModule {}

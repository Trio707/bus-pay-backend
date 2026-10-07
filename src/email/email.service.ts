import { Inject, Injectable } from '@nestjs/common';

import { controlCenterUrl } from './email.provider';
import {
  emailConfigurationTest,
  masterWakalaCredentialEmail,
} from './email.templates';
import { EMAIL_PROVIDER, type EmailProvider, type EmailSendResult } from './email.types';

@Injectable()
export class EmailService {
  constructor(@Inject(EMAIL_PROVIDER) private readonly provider: EmailProvider) {}

  sendMasterWakalaCredentials(input: {
    to: string;
    fullName: string;
    temporaryPassword: string;
    idempotencyKey: string;
  }): Promise<EmailSendResult> {
    const loginUrl = controlCenterUrl();
    const body = masterWakalaCredentialEmail({
      fullName: input.fullName,
      email: input.to,
      temporaryPassword: input.temporaryPassword,
      loginUrl,
    });
    return this.provider.send({
      to: input.to,
      subject: body.subject,
      text: body.text,
      html: body.html,
      idempotencyKey: input.idempotencyKey,
    });
  }

  sendTest(to: string): Promise<EmailSendResult> {
    const body = emailConfigurationTest();
    return this.provider.send({
      to,
      subject: body.subject,
      text: body.text,
      html: body.html,
    });
  }
}

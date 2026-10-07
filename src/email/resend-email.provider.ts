import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Resend } from 'resend';

import { EMAIL_NOT_SENT, configuredValue, redactSecrets } from './email.provider';
import type { EmailSendResult, OutboundEmail } from './email.types';

export type ResendSender = (message: OutboundEmail) => Promise<EmailSendResult>;

@Injectable()
export class ResendEmailProvider {
  private readonly logger = new Logger(ResendEmailProvider.name);

  constructor(private readonly sender: ResendSender = sendWithResendSdk) {}

  async send(message: OutboundEmail): Promise<EmailSendResult> {
    configuredValue('RESEND_API_KEY');
    configuredValue('RESEND_FROM_EMAIL');
    try {
      return await this.sender(message);
    } catch {
      this.logger.warn('Resend send failed');
      throw new ServiceUnavailableException(EMAIL_NOT_SENT);
    }
  }
}

export async function sendWithResendSdk(
  message: OutboundEmail,
): Promise<EmailSendResult> {
  const apiKey = configuredValue('RESEND_API_KEY');
  const from = configuredValue('RESEND_FROM_EMAIL');
  const resend = new Resend(apiKey);
  const result = await resend.emails.send(
    {
      from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      html: message.html,
    },
    message.idempotencyKey ? { idempotencyKey: message.idempotencyKey } : undefined,
  );
  if (result.error) {
    throw new Error(redactSecrets(result.error.message, [apiKey, message.text, message.html]));
  }
  return {
    provider: 'resend',
    providerMessageId: result.data?.id ?? null,
  };
}

export type OutboundEmail = {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey?: string;
};

export type EmailSendResult = {
  provider: 'resend';
  providerMessageId: string | null;
};

export interface EmailProvider {
  send(message: OutboundEmail): Promise<EmailSendResult>;
}

export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');

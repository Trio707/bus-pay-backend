import { ServiceUnavailableException } from '@nestjs/common';

import type { EmailProvider } from './email.types';

export const EMAIL_NOT_CONFIGURED = 'Email is not configured';
export const EMAIL_NOT_SENT = 'Email could not be sent';

export function configuredValue(name: string): string {
  const value = process.env[name]?.trim() ?? '';
  if (!value) {
    throw new ServiceUnavailableException(EMAIL_NOT_CONFIGURED);
  }
  return value;
}

export function controlCenterUrl(): string {
  const value = configuredValue('BUSPAY_CONTROL_CENTER_URL');
  if (!/^https?:\/\/\S+$/i.test(value)) {
    throw new ServiceUnavailableException(EMAIL_NOT_CONFIGURED);
  }
  return value;
}

export function redactSecrets(message: string, secrets: string[]): string {
  let safe = message;
  for (const secret of secrets) {
    if (secret) safe = safe.split(secret).join('[redacted]');
  }
  return safe;
}

export type { EmailProvider };

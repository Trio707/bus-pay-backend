export function maskMobile(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  const national = digits.startsWith('255') ? `0${digits.slice(3)}` : digits;
  if (national.length < 4) return '****';
  return `${national.slice(0, 2)}******${national.slice(-2)}`;
}

export function maskAccount(account: string): string {
  const compact = account.replace(/\s+/g, '');
  const tail = compact.slice(-4);
  return `${'*'.repeat(8)}${tail}`;
}

export function maskCardNumber(serial: string): string {
  const compact = serial.replace(/\s+/g, '');
  if (compact.length <= 4) return '****';
  return `${'*'.repeat(compact.length - 4)}${compact.slice(-4)}`;
}

export function maskDestination(method: 'MOBILE_MONEY' | 'BANK', destination: string): string {
  return method === 'MOBILE_MONEY' ? maskMobile(destination) : maskAccount(destination);
}

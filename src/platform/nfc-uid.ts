/** Canonical NFC UID. Real tags are stored as 04:A1:B2:C3:D4:55. */
export function normalizeNfcUid(value?: string | null): string | undefined {
  const compact = value?.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (!compact) return undefined;
  if (compact.length >= 8 && compact.length % 2 === 0) {
    return compact.match(/.{2}/g)!.join(':');
  }
  return compact;
}

export function nfcUidMatchKeys(value?: string | null): string[] {
  const compact = value?.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  const canonical = normalizeNfcUid(value);
  return [...new Set([canonical, compact].filter((item): item is string => !!item))];
}

export function sameNfcUid(left?: string | null, right?: string | null): boolean {
  const a = normalizeNfcUid(left);
  const b = normalizeNfcUid(right);
  return !!a && a === b;
}

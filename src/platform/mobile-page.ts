/** Page size for mobile history. Caps a request so a client cannot pull the full table. */
export function mobilePageSize(
  limit: string | number | undefined,
  fallback = 20,
) {
  const parsed = typeof limit === 'number' ? limit : Number(limit ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(50, Math.max(1, Math.trunc(parsed)));
}

export function mobileCursor(value?: string): Date | undefined {
  if (!value?.trim()) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed;
}

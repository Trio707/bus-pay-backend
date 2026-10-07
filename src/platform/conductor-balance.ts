import { Prisma } from '../generated/prisma';

/** Same conductor cannot cash out and pay out the same earnings at once. */
export async function lockConductorBalance(
  tx: Prisma.TransactionClient,
  conductorUserId: string,
) {
  const key = `buspay:conductor-balance:${conductorUserId}`;
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0::bigint))
  `;
}

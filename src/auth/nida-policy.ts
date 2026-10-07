import { ConflictException } from '@nestjs/common';
import { Prisma, UserRole } from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeNida } from './identity';

export const MAX_CONDUCTORS_PER_NIDA = 5;

type NidaClient = {
  user: {
    count: (args: {
      where: { nida: string; role: UserRole };
    }) => Promise<number>;
    findFirst: (args: {
      where: {
        nida: string;
        role: { in: UserRole[] };
      };
      select?: { id: true };
    }) => Promise<{ id: string } | null>;
  };
};

/**
 * Serializes conductor creation for one NIDA across backend processes.
 * The key is derived in PostgreSQL so JavaScript never handles the bigint.
 * pg_advisory_xact_lock releases automatically when the transaction ends.
 */
export async function lockConductorNida(
  tx: Prisma.TransactionClient,
  nida: string,
) {
  const key = `buspay:conductor-nida:${normalizeNida(nida)}`;
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0::bigint))
  `;
}

export async function assertNidaAvailable(
  prisma: NidaClient,
  nida: string,
  role: UserRole,
) {
  if (role === UserRole.CONDUCTOR) {
    const count = await prisma.user.count({
      where: { nida, role: UserRole.CONDUCTOR },
    });
    if (count >= MAX_CONDUCTORS_PER_NIDA) {
      throw new ConflictException(
        'This NIDA already has the maximum of 5 conductor accounts',
      );
    }
    return;
  }

  const staff = await prisma.user.findFirst({
    where: {
      nida,
      role: { in: [UserRole.ADMIN, UserRole.AGENT, UserRole.MASTER_AGENT] },
    },
    select: { id: true },
  });
  if (staff) {
    throw new ConflictException('NIDA is already registered');
  }
}

/** Lock, re-check the 5-conductor limit, then create, all in one transaction. */
export async function withConductorNidaLock<T>(
  prisma: PrismaService,
  nida: string,
  run: (tx: Prisma.TransactionClient, normalizedNida: string) => Promise<T>,
): Promise<T> {
  const normalized = normalizeNida(nida);
  return prisma.$transaction(async (tx) => {
    await lockConductorNida(tx, normalized);
    await assertNidaAvailable(tx, normalized, UserRole.CONDUCTOR);
    return run(tx, normalized);
  });
}

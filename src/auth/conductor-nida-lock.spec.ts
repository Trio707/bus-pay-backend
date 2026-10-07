import { ConflictException } from '@nestjs/common';
import { UserRole } from '../generated/prisma';
import { AdminService } from '../admin/admin.service';
import { AuthService } from './auth.service';
import { withConductorNidaLock } from './nida-policy';

const NIDA = '19900101123451234512';
const OTHER_NIDA = '20000101123451234512';
const LIMIT_MESSAGE = 'This NIDA already has the maximum of 5 conductor accounts';

type Row = {
  id: string;
  nida: string;
  role: string;
  phone: string;
  username?: string;
};

function store() {
  const users: Row[] = [];
  const events: string[] = [];
  const tails = new Map<string, Promise<void>>();

  function acquire(key: string): Promise<() => void> {
    const previous = tails.get(key) ?? Promise.resolve();
    let resolveCurrent: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      resolveCurrent = resolve;
    });
    tails.set(key, current);
    return previous.then(
      () => () => {
        resolveCurrent();
        if (tails.get(key) === current) tails.delete(key);
      },
    );
  }

  const prisma = {
    user: {
      findFirst: jest.fn(async ({ where }: { where?: { phone?: { in?: string[] } } }) => {
        return (
          users.find((user) => where?.phone?.in?.includes(user.phone)) ?? null
        );
      }),
      count: jest.fn(),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    merchant: { findUnique: jest.fn().mockResolvedValue(null) },
    terminal: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const staged: Row[] = [];
      let release: (() => void) | null = null;
      const tx = {
        $queryRaw: async (strings: TemplateStringsArray, key: unknown) => {
          const sql = strings.join(' ');
          if (!sql.includes('pg_advisory_xact_lock') || !sql.includes('hashtextextended')) {
            throw new Error(`unexpected lock sql: ${sql}`);
          }
          events.push(`lock:${String(key)}`);
          release = await acquire(String(key));
          return [];
        },
        user: {
          count: async ({ where }: { where: { nida: string; role: string } }) => {
            events.push(`count:${where.nida}`);
            return [...users, ...staged].filter(
              (user) => user.nida === where.nida && user.role === where.role,
            ).length;
          },
          findFirst: async () => null,
          create: async ({ data }: { data: Row }) => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            events.push(`create:${data.nida}`);
            const row = { ...data, id: `user-${users.length + staged.length + 1}` };
            staged.push(row);
            return row;
          },
        },
      };
      try {
        const result = await fn(tx);
        users.push(...staged);
        return result;
      } finally {
        release?.();
      }
    }),
  };

  function seed(nida: string, count: number) {
    for (let index = 0; index < count; index += 1) {
      users.push({
        id: `seed-${nida}-${index}`,
        nida,
        role: UserRole.CONDUCTOR,
        phone: `+25571${nida.slice(-4)}${index}`,
      });
    }
  }

  const auth = new AuthService(
    prisma as never,
    { signAsync: jest.fn() } as never,
    { enqueue: jest.fn() } as never,
    { flush: jest.fn() } as never,
  );
  const admin = new AdminService(
    prisma as never,
    { enqueue: jest.fn() } as never,
    {} as never,
  );
  return { prisma, users, events, seed, auth, admin };
}

function conductorDto(phone: string, nida = NIDA) {
  return {
    firstName: 'Juma',
    lastName: 'Omari',
    phone,
    nida,
    pin: '1234',
    confirmPin: '1234',
  };
}

describe('conductor NIDA advisory lock', () => {
  it('lets one of two concurrent self-registrations through when four accounts exist', async () => {
    const { auth, users } = store();
    users.push(
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `seed-${index}`,
        nida: NIDA,
        role: UserRole.CONDUCTOR,
        phone: `+25571200000${index}`,
      })),
    );

    const results = await Promise.allSettled([
      auth.registerConductor(conductorDto('0712000010') as never),
      auth.registerConductor(conductorDto('0712000011') as never),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toBe(LIMIT_MESSAGE);
    expect(users.filter((user) => user.nida === NIDA && user.role === UserRole.CONDUCTOR)).toHaveLength(5);
  });

  it('lets one of two concurrent admin creates through when four accounts exist', async () => {
    const { admin, users, seed } = store();
    seed(NIDA, 4);
    const actor = { id: 'admin-1' } as never;
    const results = await Promise.allSettled([
      admin.createConductor(actor, conductorDto('0712000020') as never),
      admin.createConductor(actor, conductorDto('0712000021') as never),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason.message).toBe(LIMIT_MESSAGE);
    expect(users.filter((user) => user.role === UserRole.CONDUCTOR)).toHaveLength(5);
  });

  it('allows the first conductor and the fifth, then rejects the sixth', async () => {
    const { auth, users } = store();
    await auth.registerConductor(conductorDto('0712000030') as never);
    expect(users).toHaveLength(1);

    for (let index = 1; index < 5; index += 1) {
      await auth.registerConductor(conductorDto(`071200003${index}`) as never);
    }
    expect(users).toHaveLength(5);
    await expect(
      auth.registerConductor(conductorDto('0712000039') as never),
    ).rejects.toThrow(LIMIT_MESSAGE);
    expect(users).toHaveLength(5);
  });

  it('rejects the sixth admin-created conductor and still allows another NIDA', async () => {
    const { admin, users, seed } = store();
    seed(NIDA, 5);
    const actor = { id: 'admin-1' } as never;
    await expect(
      admin.createConductor(actor, conductorDto('0712000040') as never),
    ).rejects.toThrow(LIMIT_MESSAGE);
    await admin.createConductor(
      actor,
      conductorDto('0712000041', OTHER_NIDA) as never,
    );
    expect(users.filter((user) => user.nida === NIDA)).toHaveLength(5);
    expect(users.filter((user) => user.nida === OTHER_NIDA)).toHaveLength(1);
  });

  it('treats spaced and dashed NIDA values as the same normalized number', async () => {
    const { auth, users } = store();
    await auth.registerConductor(
      conductorDto('0712000050', '1990-0101-1234-5123-4512') as never,
    );
    expect(users[0].nida).toBe(NIDA);
    for (let index = 1; index < 5; index += 1) {
      await auth.registerConductor(
        conductorDto(`071200005${index}`, '1990 0101 123451234512') as never,
      );
    }
    await expect(
      auth.registerConductor(conductorDto('0712000059', NIDA) as never),
    ).rejects.toThrow(LIMIT_MESSAGE);
    expect(users).toHaveLength(5);
  });

  it('locks the normalized NIDA before counting and creating', async () => {
    const { prisma, events } = store();
    await withConductorNidaLock(prisma as never, ` ${NIDA} `, async (tx, normalized) => {
      expect(normalized).toBe(NIDA);
      return tx.user.create({
        data: {
          nida: normalized,
          role: UserRole.CONDUCTOR,
          phone: '+255712000060',
          username: 'Bp-c100001bus',
          passwordHash: 'hash',
          firstName: 'Juma',
          lastName: 'Omari',
        },
      } as never);
    });
    const lockAt = events.findIndex((event) => event === `lock:buspay:conductor-nida:${NIDA}`);
    const countAt = events.findIndex((event) => event === `count:${NIDA}`);
    const createAt = events.findIndex((event) => event === `create:${NIDA}`);
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeLessThan(countAt);
    expect(countAt).toBeLessThan(createAt);
  });

  it('rolls back a failed create and does not leave the lock stuck', async () => {
    const { prisma, users } = store();
    await expect(
      withConductorNidaLock(prisma as never, NIDA, async () => {
        throw new Error('insert failed');
      }),
    ).rejects.toThrow('insert failed');
    expect(users).toHaveLength(0);

    const created = await Promise.race([
      withConductorNidaLock(prisma as never, NIDA, async (tx, normalized) =>
        tx.user.create({
          data: {
            nida: normalized,
            role: UserRole.CONDUCTOR,
            phone: '+255712000070',
            username: 'Bp-c100002bus',
            passwordHash: 'hash',
            firstName: 'Juma',
            lastName: 'Omari',
          },
        } as never),
      ),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('advisory lock stayed held')), 1000);
      }),
    ]);
    expect(created).toEqual(expect.objectContaining({ nida: NIDA }));
    expect(users).toHaveLength(1);
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';

import { AdminService } from '../admin/admin.service';
import { MustChangePasswordGuard } from '../auth/must-change-password.guard';
import { AuthService } from '../auth/auth.service';
import { assertStrongPassword } from '../auth/password-policy';
import { RolesGuard } from '../auth/roles.guard';
import { UserRole, UserStatus, type User } from '../generated/prisma';
import { EmailService } from './email.service';
import { EMAIL_NOT_CONFIGURED, EMAIL_NOT_SENT } from './email.provider';
import { masterWakalaCredentialEmail } from './email.templates';
import { ResendEmailProvider } from './resend-email.provider';
import type { EmailSendResult, OutboundEmail } from './email.types';

const ENV_NAMES = [
  'RESEND_API_KEY',
  'RESEND_FROM_EMAIL',
  'BUSPAY_CONTROL_CENTER_URL',
] as const;

function restoreEnv(saved: Array<[string, string | undefined]>) {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function actor(role: UserRole, id = 'user-1'): User {
  return {
    id,
    role,
    status: UserStatus.ACTIVE,
    username: 'name',
    firstName: 'Amina',
    lastName: 'Juma',
    phone: '+255712345678',
    email: 'amina@example.com',
    passwordHash: 'hash',
  } as User;
}

function httpContext(user: User | undefined) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => 'handler',
    getClass: () => 'class',
  } as never;
}

describe('Resend onboarding email', () => {
  const saved = ENV_NAMES.map(
    (name) => [name, process.env[name]] as [string, string | undefined],
  );

  afterEach(() => {
    restoreEnv(saved);
    jest.restoreAllMocks();
  });

  it('sends through the configured provider and keeps the sender in the environment', async () => {
    process.env.RESEND_API_KEY = 'unit-test-resend-key';
    process.env.RESEND_FROM_EMAIL = 'BusPay <onboarding@example.com>';
    process.env.BUSPAY_CONTROL_CENTER_URL = 'http://localhost:5173';
    const seen: OutboundEmail[] = [];
    const provider = new ResendEmailProvider(async (message) => {
      seen.push(message);
      return { provider: 'resend', providerMessageId: 'msg_1' };
    });
    const email = new EmailService(provider);
    const result = await email.sendMasterWakalaCredentials({
      to: 'amina@example.com',
      fullName: 'AMINA JUMA',
      temporaryPassword: 'Temp-Value-Not-Logged-1',
      idempotencyKey: 'master-wakala-user-1-0',
    });
    expect(result).toEqual({ provider: 'resend', providerMessageId: 'msg_1' });
    expect(seen[0]?.idempotencyKey).toBe('master-wakala-user-1-0');
    expect(seen[0]?.subject).toBe('Your BusPay Master Wakala Account');
    const again = await email.sendMasterWakalaCredentials({
      to: 'amina@example.com',
      fullName: 'AMINA JUMA',
      temporaryPassword: 'Temp-Value-Not-Logged-1',
      idempotencyKey: 'master-wakala-user-1-0',
    });
    expect(again.providerMessageId).toBe('msg_1');
    expect(seen[1]?.idempotencyKey).toBe(seen[0]?.idempotencyKey);
  });

  it('fails safely when RESEND_API_KEY is missing', async () => {
    delete process.env.RESEND_API_KEY;
    process.env.RESEND_FROM_EMAIL = 'BusPay <onboarding@example.com>';
    const provider = new ResendEmailProvider(async () => {
      throw new Error('sender should not run');
    });
    await expect(provider.send(sampleMessage())).rejects.toMatchObject({
      message: EMAIL_NOT_CONFIGURED,
    });
  });

  it('fails safely when RESEND_FROM_EMAIL is missing', async () => {
    process.env.RESEND_API_KEY = 'unit-test-resend-key';
    delete process.env.RESEND_FROM_EMAIL;
    const provider = new ResendEmailProvider(async () => {
      throw new Error('sender should not run');
    });
    await expect(provider.send(sampleMessage())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('does not log the API key when Resend rejects the message', async () => {
    const secret = 'unit-test-resend-key';
    process.env.RESEND_API_KEY = secret;
    process.env.RESEND_FROM_EMAIL = 'BusPay <onboarding@example.com>';
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const provider = new ResendEmailProvider(async () => {
      throw new Error(`provider rejected ${secret}`);
    });
    try {
      await provider.send(sampleMessage());
      throw new Error('expected send to fail');
    } catch (error) {
      const response =
        error instanceof ServiceUnavailableException
          ? JSON.stringify(error.getResponse())
          : '';
      expect(response.includes(secret)).toBe(false);
      expect(error).toBeInstanceOf(ServiceUnavailableException);
    }
    const logged = warn.mock.calls.map((call) => String(call[0])).join(' ');
    expect(logged.includes(secret)).toBe(false);
    expect(logged).toContain('Resend send failed');
  });

  it('does not hard-code a BusPay domain in the email module', () => {
    const files = [
      'email.templates.ts',
      'email.service.ts',
      'email.provider.ts',
      'resend-email.provider.ts',
      'email.module.ts',
    ];
    for (const file of files) {
      const source = readFileSync(join(__dirname, file), 'utf8').toLowerCase();
      expect(source.includes('buspay.co.tz')).toBe(false);
      expect(source.includes('@buspay.com')).toBe(false);
      expect(source.includes('@buspay.tz')).toBe(false);
    }
  });

  it('builds a credential email without internal identifiers', () => {
    const body = masterWakalaCredentialEmail({
      fullName: 'Amina <Juma>',
      email: 'amina@example.com',
      temporaryPassword: 'Temp&Pass',
      loginUrl: 'http://localhost:5173',
    });
    expect(body.subject).toBe('Your BusPay Master Wakala Account');
    expect(body.html.includes('Amina &lt;Juma&gt;')).toBe(true);
    expect(body.html.includes('Temp&amp;Pass')).toBe(true);
    expect(body.text.includes('change your temporary password')).toBe(true);
    expect(body.text.toLowerCase().includes('nida')).toBe(false);
  });
});

describe('Master Wakala credential onboarding', () => {
  const saved = ENV_NAMES.map(
    (name) => [name, process.env[name]] as [string, string | undefined],
  );

  afterEach(() => {
    restoreEnv(saved);
  });

  function setup(send: (input: {
    to: string;
    fullName: string;
    temporaryPassword: string;
    idempotencyKey: string;
  }) => Promise<EmailSendResult>) {
    const audits: Array<{ action: string; metadata?: unknown }> = [];
    const prisma = {
      user: {
        findUnique: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn(),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'master-9',
          status: UserStatus.ACTIVE,
          createdAt: new Date('2026-10-07T00:00:00.000Z'),
          sessionVersion: 0,
          credentialEmailSentAt: null,
          ...data,
          permissions: (
            (data.permissions as { create?: { permissionCode: string }[] } | undefined)
              ?.create ?? []
          ).map((row) => ({ permissionCode: row.permissionCode })),
        })),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'master-9',
          ...data,
        })),
        count: jest.fn().mockResolvedValue(0),
      },
      userPermission: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn(),
        createMany: jest.fn(),
      },
      auditLog: {
        create: jest.fn(async ({ data }: { data: { action: string; metadata?: unknown } }) => {
          audits.push(data);
          return data;
        }),
      },
    };
    const email = {
      sendMasterWakalaCredentials: jest.fn(send),
      sendTest: jest.fn(async () => ({
        provider: 'resend' as const,
        providerMessageId: 'msg_test',
      })),
    };
    const service = new AdminService(
      prisma as never,
      { enqueue: jest.fn() } as never,
      { getBalance: jest.fn(), record: jest.fn() } as never,
      undefined,
      email as unknown as EmailService,
    );
    return { service, prisma, email, audits };
  }

  const admin = actor(UserRole.ADMIN, 'admin-1');
  const dto = {
    firstName: 'Amina',
    lastName: 'Juma',
    email: 'Amina@Example.com',
    phone: '0712345678',
    nida: '19900101123456789012',
    permissions: ['DASHBOARD_VIEW'],
  };

  it('sends onboarding email, hides the temporary password, and stores only a hash', async () => {
    let captured = '';
    const { service, prisma, email, audits } = setup(async (input) => {
      captured = input.temporaryPassword;
      expect(input.idempotencyKey).toBe('master-wakala-master-9-0');
      expect(input.to).toBe('amina@example.com');
      return { provider: 'resend', providerMessageId: 'msg_create' };
    });

    const created = await service.createMasterWakala(admin, dto);
    const stored = prisma.user.create.mock.calls[0][0].data.passwordHash as string;
    expect(created.emailSent).toBe(true);
    expect(created.onboarding).toBe('EMAIL_SENT');
    expect(created.message).toBe(
      'Master Wakala account created and onboarding email sent.',
    );
    expect(JSON.stringify(created).includes(captured)).toBe(false);
    expect(stored === captured).toBe(false);
    expect(await bcrypt.compare(captured, stored)).toBe(true);
    assertStrongPassword(captured, {
      phone: '+255712345678',
      nida: dto.nida,
      username: prisma.user.create.mock.calls[0][0].data.username,
    });
    expect(captured.length).toBeGreaterThanOrEqual(16);
    expect(email.sendMasterWakalaCredentials).toHaveBeenCalledTimes(1);
    expect(audits.map((row) => row.action)).toContain('MASTER_AGENT_EMAIL_SENT');
    const sent = audits.find((row) => row.action === 'MASTER_AGENT_EMAIL_SENT');
    expect(sent?.metadata).toEqual(
      expect.objectContaining({
        targetUserId: 'master-9',
        provider: 'resend',
        providerMessageId: 'msg_create',
      }),
    );
    const auditText = JSON.stringify(audits);
    expect(auditText.includes(captured)).toBe(false);
    expect(auditText.toLowerCase().includes('passwordhash')).toBe(false);
  });

  it('does not report success when email delivery fails and leaves the account pending', async () => {
    let captured = '';
    const { service, prisma, audits } = setup(async (input) => {
      captured = input.temporaryPassword;
      throw new ServiceUnavailableException(EMAIL_NOT_SENT);
    });
    const created = await service.createMasterWakala(admin, dto);
    expect(created.emailSent).toBe(false);
    expect(created.onboarding).toBe('PENDING_EMAIL');
    expect(created.message).toBe(
      'Master Wakala account could not be fully onboarded because the onboarding email could not be sent.',
    );
    expect(JSON.stringify(created).includes(captured)).toBe(false);
    expect(
      prisma.user.update.mock.calls.some((call) => call[0].data.credentialEmailSentAt),
    ).toBe(false);
    expect(audits.map((row) => row.action)).toContain('MASTER_AGENT_EMAIL_FAILED');
    expect(audits.map((row) => row.action)).not.toContain('MASTER_AGENT_EMAIL_SENT');
    expect(JSON.stringify(audits).includes(captured)).toBe(false);
  });

  it('replaces the password when credentials are resent and keeps the new password out of the response', async () => {
    const oldPassword = 'Old-Temp-Pass-1';
    const oldHash = await bcrypt.hash(oldPassword, 4);
    let sessionVersion = 2;
    let passwordHash = oldHash;
    let sentAt: Date | null = new Date('2026-10-01T00:00:00.000Z');
    let captured = '';
    const { service, prisma, audits } = setup(async (input) => {
      captured = input.temporaryPassword;
      expect(input.idempotencyKey).toBe('master-wakala-master-1-3');
      return { provider: 'resend', providerMessageId: 'msg_resend' };
    });
    prisma.user.findUnique.mockResolvedValue({
      id: 'master-1',
      role: UserRole.MASTER_AGENT,
      email: 'amina@example.com',
      firstName: 'Amina',
      lastName: 'Juma',
      phone: '+255712345678',
      username: 'Bp-m100000lead',
      status: UserStatus.ACTIVE,
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      sessionVersion,
      passwordHash,
      credentialEmailSentAt: sentAt,
      nida: '19900101123456789012',
      failedLoginAttempts: 0,
      lockedUntil: null,
    });
    prisma.user.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      if (typeof data.passwordHash === 'string') passwordHash = data.passwordHash;
      if (
        data.sessionVersion &&
        typeof data.sessionVersion === 'object' &&
        'increment' in data.sessionVersion
      ) {
        sessionVersion += 1;
      }
      if ('credentialEmailSentAt' in data) {
        sentAt = (data.credentialEmailSentAt as Date | null) ?? null;
      }
      return {
        id: 'master-1',
        role: UserRole.MASTER_AGENT,
        email: 'amina@example.com',
        firstName: 'Amina',
        lastName: 'Juma',
        phone: '+255712345678',
        username: 'Bp-m100000lead',
        status: UserStatus.ACTIVE,
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
        sessionVersion,
        passwordHash,
        credentialEmailSentAt: sentAt,
        permissions: [],
        nida: '19900101123456789012',
        failedLoginAttempts: 0,
        lockedUntil: null,
      };
    });

    const result = await service.resendMasterCredentials(admin, 'master-1');
    expect(result.emailSent).toBe(true);
    expect(result.message).toBe('Onboarding email sent.');
    expect(JSON.stringify(result).includes(captured)).toBe(false);
    expect(await bcrypt.compare(oldPassword, passwordHash)).toBe(false);
    expect(await bcrypt.compare(captured, passwordHash)).toBe(true);
    expect(audits.map((row) => row.action)).toContain('MASTER_AGENT_CREDENTIALS_RESENT');
    expect(JSON.stringify(audits).includes(captured)).toBe(false);

    const auth = new AuthService(
      {
        user: {
          findFirst: jest.fn(async () => ({
            id: 'master-1',
            username: 'Bp-m100000lead',
            firstName: 'Amina',
            lastName: 'Juma',
            phone: '+255712345678',
            email: 'amina@example.com',
            role: UserRole.MASTER_AGENT,
            status: UserStatus.ACTIVE,
            tillNumber: null,
            passwordHash,
            mustChangePassword: true,
            credentialEmailSentAt: sentAt,
            failedLoginAttempts: 0,
            lockedUntil: null,
            sessionVersion,
            profilePhotoKey: null,
            profilePhotoUpdatedAt: null,
          })),
          update: jest.fn(async () => ({ sessionVersion: sessionVersion + 1 })),
        },
        userPermission: {
          findMany: jest.fn().mockResolvedValue([{ permissionCode: 'DASHBOARD_VIEW' }]),
        },
        auditLog: { create: jest.fn().mockResolvedValue({}) },
      } as never,
      { signAsync: jest.fn().mockResolvedValue('token') } as unknown as JwtService,
      { enqueue: jest.fn() } as never,
      { flush: jest.fn() } as never,
    );
    await expect(
      auth.loginAdmin({ email: 'amina@example.com', password: oldPassword }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    const session = await auth.loginAdmin({
      email: 'amina@example.com',
      password: captured,
    });
    expect(session.user.role).toBe('master_agent');
    expect(session.user.mustChangePassword).toBe(true);
    expect(JSON.stringify(session).includes(captured)).toBe(false);
  });

  it('refuses credential resend and the email test to non-admin roles', async () => {
    const { service } = setup(async () => ({
      provider: 'resend',
      providerMessageId: 'msg',
    }));
    for (const role of [UserRole.MASTER_AGENT, UserRole.AGENT, UserRole.CONDUCTOR]) {
      await expect(
        service.resendMasterCredentials(actor(role), 'master-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.sendTestEmail(actor(role), 'admin@example.com'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
    const guard = new RolesGuard({
      getAllAndOverride: () => [UserRole.ADMIN],
    } as never);
    expect(guard.canActivate(httpContext(actor(UserRole.ADMIN)))).toBe(true);
    expect(guard.canActivate(httpContext(actor(UserRole.MASTER_AGENT)))).toBe(false);
    expect(guard.canActivate(httpContext(actor(UserRole.AGENT)))).toBe(false);
    expect(guard.canActivate(httpContext(actor(UserRole.CONDUCTOR)))).toBe(false);
  });

  it('sends a harmless test email for an admin', async () => {
    const { service, email } = setup(async () => ({
      provider: 'resend',
      providerMessageId: 'unused',
    }));
    const result = await service.sendTestEmail(admin, 'Desk@Example.com');
    expect(result).toEqual({
      sent: true,
      provider: 'resend',
      providerMessageId: 'msg_test',
    });
    expect(email.sendTest).toHaveBeenCalledWith('desk@example.com');
    expect(JSON.stringify(result).toLowerCase().includes('resend_api_key')).toBe(false);
  });
});

describe('Master Wakala login after onboarding email', () => {
  function harness(password: string, sent: Date | null) {
    const row = {
      id: 'master-1',
      username: 'Bp-m100000lead',
      firstName: 'Amina',
      lastName: 'Juma',
      phone: '+255712345678',
      email: 'amina@example.com',
      nida: '19900101123456789012',
      role: UserRole.MASTER_AGENT,
      status: UserStatus.ACTIVE,
      tillNumber: null,
      passwordHash: '',
      mustChangePassword: true,
      credentialEmailSentAt: sent,
      failedLoginAttempts: 0,
      lockedUntil: null as Date | null,
      sessionVersion: 1,
      profilePhotoKey: null,
      profilePhotoUpdatedAt: null,
    };
    const audits: Array<{ action: string; metadata?: unknown }> = [];
    const ready = bcrypt.hash(password, 4).then((hash) => {
      row.passwordHash = hash;
    });
    const prisma = {
      user: {
        findFirst: jest.fn(async () => row),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (typeof data.passwordHash === 'string') row.passwordHash = data.passwordHash;
          if (typeof data.mustChangePassword === 'boolean') {
            row.mustChangePassword = data.mustChangePassword;
          }
          if (typeof data.failedLoginAttempts === 'number') {
            row.failedLoginAttempts = data.failedLoginAttempts;
          }
          if ('lockedUntil' in data) row.lockedUntil = data.lockedUntil as Date | null;
          if (data.sessionVersion && typeof data.sessionVersion === 'object') {
            row.sessionVersion += 1;
          }
          return { sessionVersion: row.sessionVersion };
        }),
      },
      userPermission: {
        findMany: jest.fn().mockResolvedValue([{ permissionCode: 'DASHBOARD_VIEW' }]),
      },
      auditLog: {
        create: jest.fn(async ({ data }: { data: { action: string; metadata?: unknown } }) => {
          audits.push(data);
          return data;
        }),
      },
    };
    const service = new AuthService(
      prisma as never,
      { signAsync: jest.fn().mockResolvedValue('token') } as unknown as JwtService,
      { enqueue: jest.fn() } as never,
      { flush: jest.fn() } as never,
    );
    return { service, row, audits, ready };
  }

  it('blocks login while the onboarding email has not been sent', async () => {
    const { service, ready } = harness('Temp-Login-Pass-1', null);
    await ready;
    await expect(
      service.loginAdmin({
        email: 'amina@example.com',
        password: 'Temp-Login-Pass-1',
      }),
    ).rejects.toThrow('Onboarding email has not been sent');
  });

  it('requires a password change, then accepts only the new password', async () => {
    const temporary = 'Temp-Login-Pass-1';
    const next = 'Changed-Login-Pass-1';
    const { service, row, audits, ready } = harness(temporary, new Date());
    await ready;
    const guard = new MustChangePasswordGuard();

    const first = await service.loginAdmin({
      email: 'amina@example.com',
      password: temporary,
    });
    expect(first.user.role).toBe('master_agent');
    expect(first.user.mustChangePassword).toBe(true);
    expect(() =>
      guard.canActivate(
        httpContext({
          role: UserRole.MASTER_AGENT,
          mustChangePassword: true,
        } as User),
      ),
    ).toThrow('Change your password before continuing');

    await service.changeDashboardPassword(row as unknown as User, {
      currentPassword: temporary,
      password: next,
      confirmPassword: next,
    });
    expect(row.mustChangePassword).toBe(false);
    expect(JSON.stringify(audits).includes(temporary)).toBe(false);
    expect(JSON.stringify(audits).includes(next)).toBe(false);
    expect(
      guard.canActivate(
        httpContext({
          role: UserRole.MASTER_AGENT,
          mustChangePassword: false,
        } as User),
      ),
    ).toBe(true);

    await expect(
      service.loginAdmin({ email: 'amina@example.com', password: temporary }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    const second = await service.loginAdmin({
      email: 'amina@example.com',
      password: next,
    });
    expect(second.user.mustChangePassword).toBe(false);
    expect(second.user.role).toBe('master_agent');
  });
});

function sampleMessage(): OutboundEmail {
  return {
    to: 'amina@example.com',
    subject: 'BusPay email configuration test',
    text: 'No account credentials are included.',
    html: '<p>No account credentials are included.</p>',
  };
}

import { randomInt } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma, UserRole, UserStatus, type User } from '../generated/prisma';
import * as bcrypt from 'bcrypt';

import { PrismaService } from '../prisma/prisma.service';
import { SmsDispatcherService } from '../sms/sms-dispatcher.service';
import { SmsService } from '../sms/sms.service';
import { wakalaAccountSms } from '../sms/sms-copy';
import { ALL_PERMISSION_CODES } from './permissions';
import { assertNidaAvailable, withConductorNidaLock } from './nida-policy';
import {
  assertStrongPassword,
  generateTemporaryPassword,
} from './password-policy';
import { AgentForgotPasswordDto } from './dto/agent-forgot-password.dto';
import { AgentLoginDto } from './dto/agent-login.dto';
import { AgentRegisterDto } from './dto/agent-register.dto';
import { CreateWakalaDto } from './dto/create-wakala.dto';
import { AgentResetPasswordDto } from './dto/agent-reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ChangePinDto } from './dto/change-pin.dto';
import { ForgotPinDto } from './dto/forgot-pin.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPinDto } from './dto/reset-pin.dto';
import { normalizeEmail } from './email';
import {
  normalizeName,
  normalizeNida,
  normalizePhone,
  phoneLookupValues,
} from './identity';

const CONDUCTOR_ID = /^bp-c[a-z0-9]{6}bus$/i;
const AGENT_ID = /^bp-a[a-z0-9]{6}agent$/i;
const MAX_PIN_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const RESET_CODE_MS = 10 * 60 * 1000;
const MAX_RESET_ATTEMPTS = 5;
const BAD_CREDENTIALS = 'Incorrect username or password';

type ApiRole = 'conductor' | 'agent' | 'admin' | 'master_agent';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly resetCodes = new Map<
    string,
    { hash: string; expiresAt: number; nida?: string; attempts: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly sms: SmsService,
    private readonly smsDispatcher: SmsDispatcherService,
  ) {}

  async registerConductor(dto: RegisterDto) {
    return this.registerUser(dto, UserRole.CONDUCTOR);
  }

  async registerAgent(dto: AgentRegisterDto) {
    if (dto.password !== dto.confirmPassword) {
      throw new BadRequestException('Passwords do not match');
    }
    return this.createWakala({
      firstName: dto.firstName,
      lastName: dto.lastName,
      email: dto.email,
      phone: dto.phone,
      nida: dto.nida,
      password: dto.password,
    });
  }

  async createWakala(dto: CreateWakalaDto, actor?: User) {
    if (
      actor?.role &&
      actor.role !== UserRole.ADMIN &&
      actor.role !== UserRole.MASTER_AGENT
    ) {
      throw new ForbiddenException();
    }

    const firstName = normalizeName(dto.firstName);
    const lastName = normalizeName(dto.lastName);
    const phone = normalizePhone(dto.phone);
    const nida = normalizeNida(dto.nida);
    const email = normalizeEmail(dto.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('Use a valid email');
    }

    const existingPhone = await this.prisma.user.findFirst({
      where: { phone: { in: phoneLookupValues(phone) } },
    });
    if (existingPhone) {
      throw new ConflictException('Phone number is already registered');
    }

    await assertNidaAvailable(this.prisma, nida, UserRole.AGENT);

    const existingEmail = await this.prisma.user.findFirst({
      where: {
        role: UserRole.AGENT,
        email: {
          equals: email,
          mode: 'insensitive',
        },
      },
    });
    if (existingEmail) {
      throw new ConflictException('Email is already registered');
    }

    const issuedByAdmin = Boolean(actor);
    const temporaryPassword = issuedByAdmin
      ? generateTemporaryPassword()
      : dto.password;
    if (!temporaryPassword) {
      throw new BadRequestException('Password is required');
    }
    if (!issuedByAdmin) {
      assertStrongPassword(temporaryPassword, { phone, nida });
    }
    const passwordHash = await bcrypt.hash(temporaryPassword, 12);
    const username = await this.uniqueUsername(UserRole.AGENT);

    const user = await this.prisma.user.create({
      data: {
        username,
        passwordHash,
        firstName,
        lastName,
        phone,
        nida,
        email,
        tillNumber: this.formatTill(nida),
        role: UserRole.AGENT,
        mustChangePassword: issuedByAdmin,
      },
    });

    if (actor) {
      await this.prisma.auditLog.create({
        data: {
          actorUserId: actor.id,
          action: 'USER_CREATE',
          entityType: 'User',
          entityId: user.id,
          metadata: {
            role: 'agent',
            username: user.username,
            mustChangePassword: true,
          },
        },
      });
      await this.prisma.auditLog.create({
        data: {
          actorUserId: actor.id,
          action: 'PASSWORD_ISSUED',
          entityType: 'User',
          entityId: user.id,
          metadata: { channel: 'sms-notice' },
        },
      });
      try {
        await this.sms.enqueue(
          phone,
          'WAKALA_ACCOUNT_CREDENTIALS',
          wakalaAccountSms(user.username),
        );
        void this.smsDispatcher.flush();
      } catch (error) {
        this.logger.warn(
          `Wakala credential SMS was not queued for ${user.id}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }

    return {
      message: 'Registration successful',
      username: user.username,
      role: this.toApiRole(user.role),
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      email: user.email,
      tillNumber: user.tillNumber,
    };
  }

  private async registerUser(dto: RegisterDto, role: UserRole) {
    if (dto.pin !== dto.confirmPin) {
      throw new BadRequestException('PINs do not match');
    }

    const firstName = normalizeName(dto.firstName);
    const lastName = normalizeName(dto.lastName);
    const phone = normalizePhone(dto.phone);
    const nida = normalizeNida(dto.nida);

    const existingPhone = await this.prisma.user.findFirst({
      where: { phone: { in: phoneLookupValues(phone) } },
    });
    if (existingPhone) {
      throw new ConflictException('Phone number is already registered');
    }

    const passwordHash = await bcrypt.hash(dto.pin, 12);
    const tillNumber =
      role === UserRole.AGENT ? this.formatTill(nida) : null;

    const user =
      role === UserRole.CONDUCTOR
        ? await withConductorNidaLock(this.prisma, nida, async (tx, normalized) => {
            const username = await this.uniqueUsername(role, tx);
            return tx.user.create({
              data: {
                username,
                passwordHash,
                firstName,
                lastName,
                phone,
                nida: normalized,
                tillNumber,
                role,
              },
            });
          })
        : await (async () => {
            await assertNidaAvailable(this.prisma, nida, role);
            const username = await this.uniqueUsername(role);
            return this.prisma.user.create({
              data: {
                username,
                passwordHash,
                firstName,
                lastName,
                phone,
                nida,
                tillNumber,
                role,
              },
            });
          })();

    if (role === UserRole.CONDUCTOR) {
      await this.ensureConductorTerminal(user.id);
    }

    return {
      message: 'Registration successful',
      username: user.username,
      role: this.toApiRole(user.role),
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      tillNumber: user.tillNumber,
    };
  }

  /** Assign a free APP terminal (or create one) so the conductor can collect fare. */
  private async ensureConductorTerminal(conductorUserId: string) {
    const existing = await this.prisma.terminal.findFirst({
      where: { ownerUserId: conductorUserId, status: 'ACTIVE' },
    });
    if (existing) return existing;

    const merchant = await this.prisma.merchant.findUnique({
      where: { merchantCode: 'DLD-PLATFORM' },
    });
    if (!merchant) {
      this.logger.warn('DLD-PLATFORM merchant missing; conductor has no terminal yet');
      return null;
    }

    const free = await this.prisma.terminal.findFirst({
      where: {
        merchantId: merchant.id,
        ownerUserId: null,
        status: 'ACTIVE',
      },
      orderBy: { terminalCode: 'asc' },
    });
    if (free) {
      return this.prisma.terminal.update({
        where: { id: free.id },
        data: { ownerUserId: conductorUserId },
      });
    }

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const terminalCode = `DLD-C${String(randomInt(100, 9999)).padStart(4, '0')}`;
      const taken = await this.prisma.terminal.findUnique({
        where: { terminalCode },
      });
      if (taken) continue;
      return this.prisma.terminal.create({
        data: {
          terminalCode,
          merchantId: merchant.id,
          ownerUserId: conductorUserId,
          type: 'APP',
          status: 'ACTIVE',
        },
      });
    }
    this.logger.warn(`Could not allocate terminal for conductor ${conductorUserId}`);
    return null;
  }

  async login(dto: LoginDto) {
    const username = dto.username?.trim() ?? '';
    const phoneRaw = dto.phone?.trim() ?? '';

    if (!username && !phoneRaw) {
      throw new UnauthorizedException('Account not found');
    }

    let user =
      phoneRaw.length > 0
        ? await this.prisma.user.findFirst({
            where: {
              role: UserRole.CONDUCTOR,
              phone: { in: phoneLookupValues(normalizePhone(phoneRaw)) },
            },
          })
        : null;

    if (!user && username) {
      if (!CONDUCTOR_ID.test(username) && !AGENT_ID.test(username)) {
        throw new UnauthorizedException('Account not found');
      }
      user = await this.prisma.user.findFirst({
        where: {
          username: {
            equals: username,
            mode: 'insensitive',
          },
        },
      });
    }

    if (!user) {
      throw new UnauthorizedException('Account not found');
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('Account is not active');
    }

    const lockout = this.lockoutOf(user);
    if (lockout.lockedUntil && lockout.lockedUntil.getTime() > Date.now()) {
      this.throwLocked(lockout.lockedUntil);
    }

    const passwordMatches = await bcrypt.compare(dto.pin, user.passwordHash);
    if (!passwordMatches) {
      await this.registerFailedAttempt(user.id, lockout.failedLoginAttempts);
    }

    return this.issueSession(user);
  }

  async loginAgent(dto: AgentLoginDto) {
    const email = normalizeEmail(dto.email);
    const user = await this.prisma.user.findFirst({
      where: {
        role: UserRole.AGENT,
        email: {
          equals: email,
          mode: 'insensitive',
        },
      },
    });

    if (!user) {
      throw new UnauthorizedException(BAD_CREDENTIALS);
    }

    if (user.role !== UserRole.AGENT) {
      throw new UnauthorizedException(BAD_CREDENTIALS);
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException(BAD_CREDENTIALS);
    }

    const lockout = this.lockoutOf(user);
    if (lockout.lockedUntil && lockout.lockedUntil.getTime() > Date.now()) {
      this.throwLocked(lockout.lockedUntil);
    }

    const passwordMatches = await bcrypt.compare(
      dto.password,
      user.passwordHash,
    );
    if (!passwordMatches) {
      await this.registerFailedAttempt(
        user.id,
        lockout.failedLoginAttempts,
        'credentials',
      );
    }

    return this.issueSession(user);
  }

  async loginAdmin(dto: AgentLoginDto) {
    const email = normalizeEmail(dto.email);
    const user = await this.prisma.user.findFirst({
      where: {
        role: { in: [UserRole.ADMIN, UserRole.MASTER_AGENT] },
        email: {
          equals: email,
          mode: 'insensitive',
        },
      },
    });

    if (!user) {
      throw new UnauthorizedException(BAD_CREDENTIALS);
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException(BAD_CREDENTIALS);
    }

    const lockout = this.lockoutOf(user);
    if (lockout.lockedUntil && lockout.lockedUntil.getTime() > Date.now()) {
      this.throwLocked(lockout.lockedUntil);
    }

    const passwordMatches = await bcrypt.compare(
      dto.password,
      user.passwordHash,
    );
    if (!passwordMatches) {
      await this.registerFailedAttempt(
        user.id,
        lockout.failedLoginAttempts,
        'credentials',
      );
    }

    if (user.role === UserRole.MASTER_AGENT && !user.credentialEmailSentAt) {
      throw new UnauthorizedException('Onboarding email has not been sent');
    }

    return this.issueSession(user);
  }

  async dashboardSession(user: User) {
    if (user.role !== UserRole.ADMIN && user.role !== UserRole.MASTER_AGENT) {
      throw new ForbiddenException();
    }
    if (user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException(BAD_CREDENTIALS);
    }
    return {
      user: {
        id: user.id,
        username: user.username,
        firstName: normalizeName(user.firstName),
        lastName: normalizeName(user.lastName),
        phone: user.phone,
        email: user.email,
        role: this.toApiRole(user.role),
        tillNumber: user.tillNumber,
        mustChangePassword: Boolean(user.mustChangePassword),
        permissions: await this.permissionCodes(user),
      },
    };
  }

  async forgotAgentPassword(dto: AgentForgotPasswordDto) {
    const email = normalizeEmail(dto.email);
    const user = await this.prisma.user.findFirst({
      where: {
        role: UserRole.AGENT,
        email: {
          equals: email,
          mode: 'insensitive',
        },
      },
    });

    const message = 'If this email is registered, a reset code was sent.';
    if (!user) {
      return { message };
    }

    const code = String(randomInt(100000, 1000000));
    const hash = await bcrypt.hash(code, 10);
    this.resetCodes.set(this.resetKey('agent', email), {
      hash,
      expiresAt: Date.now() + RESET_CODE_MS,
      attempts: 0,
    });
    this.logger.log(`Password reset code for ${email}: ${code}`);

    return {
      message,
      code,
    };
  }

  async resetAgentPassword(dto: AgentResetPasswordDto) {
    if (dto.password !== dto.confirmPassword) {
      throw new BadRequestException('Passwords do not match');
    }

    const email = normalizeEmail(dto.email);
    const key = this.resetKey('agent', email);
    await this.assertResetCode(key, dto.code);

    const user = await this.prisma.user.findFirst({
      where: {
        role: UserRole.AGENT,
        email: {
          equals: email,
          mode: 'insensitive',
        },
      },
    });
    if (!user) {
      throw new UnauthorizedException('Account not found');
    }

    assertStrongPassword(dto.password, {
      phone: user.phone,
      nida: user.nida,
      username: user.username,
    });
    const passwordHash = await bcrypt.hash(dto.password, 12);
    await this.replaceCredential(user.id, passwordHash);
    this.resetCodes.delete(key);

    return { message: 'Password reset successful' };
  }

  async changeAgentPassword(user: User, dto: ChangePasswordDto) {
    if (user.role !== UserRole.AGENT) {
      throw new ForbiddenException('Only agents can change password here');
    }
    if (dto.password !== dto.confirmPassword) {
      throw new BadRequestException('Passwords do not match');
    }

    const lockout = this.lockoutOf(user);
    if (lockout.lockedUntil && lockout.lockedUntil.getTime() > Date.now()) {
      this.throwLocked(lockout.lockedUntil);
    }

    const matches = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!matches) {
      await this.registerFailedAttempt(user.id, lockout.failedLoginAttempts);
    }

    if (dto.password === dto.currentPassword) {
      throw new BadRequestException('New password must be different');
    }
    assertStrongPassword(dto.password, {
      phone: user.phone,
      nida: user.nida,
      username: user.username,
    });

    const passwordHash = await bcrypt.hash(dto.password, 12);
    await this.replaceCredential(user.id, passwordHash);
    await this.prisma.auditLog.create({
      data: {
        actorUserId: user.id,
        action: 'PASSWORD_CHANGED',
        entityType: 'User',
        entityId: user.id,
        metadata: { role: 'agent' },
      },
    });
    return { message: 'Password changed successfully' };
  }

  async changeDashboardPassword(user: User, dto: ChangePasswordDto) {
    if (user.role !== UserRole.ADMIN && user.role !== UserRole.MASTER_AGENT) {
      throw new ForbiddenException();
    }
    if (dto.password !== dto.confirmPassword) {
      throw new BadRequestException('Passwords do not match');
    }

    const lockout = this.lockoutOf(user);
    if (lockout.lockedUntil && lockout.lockedUntil.getTime() > Date.now()) {
      this.throwLocked(lockout.lockedUntil);
    }

    const matches = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!matches) {
      await this.registerFailedAttempt(user.id, lockout.failedLoginAttempts, 'credentials');
    }

    if (dto.password === dto.currentPassword) {
      throw new BadRequestException('New password must be different');
    }
    assertStrongPassword(dto.password, {
      phone: user.phone,
      nida: user.nida,
      username: user.username,
    });

    const passwordHash = await bcrypt.hash(dto.password, 12);
    await this.replaceCredential(user.id, passwordHash);
    await this.prisma.auditLog.create({
      data: {
        actorUserId: user.id,
        action: 'PASSWORD_CHANGED',
        entityType: 'User',
        entityId: user.id,
        metadata: { role: this.toApiRole(user.role) },
      },
    });
    return { message: 'Password changed successfully' };
  }

  async changePin(user: User, dto: ChangePinDto) {
    if (user.role !== UserRole.CONDUCTOR) {
      throw new ForbiddenException('Only conductors can change PIN here');
    }
    if (dto.newPin !== dto.confirmPin) {
      throw new BadRequestException('PINs do not match');
    }

    const lockout = this.lockoutOf(user);
    if (lockout.lockedUntil && lockout.lockedUntil.getTime() > Date.now()) {
      this.throwLocked(lockout.lockedUntil);
    }

    const matches = await bcrypt.compare(dto.currentPin, user.passwordHash);
    if (!matches) {
      await this.registerFailedAttempt(user.id, lockout.failedLoginAttempts);
    }

    if (dto.newPin === dto.currentPin) {
      throw new BadRequestException('New PIN must be different');
    }

    const passwordHash = await bcrypt.hash(dto.newPin, 12);
    await this.replaceCredential(user.id, passwordHash);
    return { message: 'PIN changed successfully' };
  }

  async forgotPin(dto: ForgotPinDto) {
    const phone = normalizePhone(dto.phone);
    const nida = normalizeNida(dto.nida);
    const user = await this.prisma.user.findFirst({
      where: {
        role: UserRole.CONDUCTOR,
        nida,
        phone: { in: phoneLookupValues(phone) },
      },
    });

    const message =
      'If this account is registered, a verification code was sent.';
    if (!user || user.status !== UserStatus.ACTIVE) {
      return { message };
    }

    const code = String(randomInt(100000, 1000000));
    const hash = await bcrypt.hash(code, 10);
    this.resetCodes.set(this.resetKey('conductor', phone), {
      hash,
      expiresAt: Date.now() + RESET_CODE_MS,
      nida,
      attempts: 0,
    });
    this.logger.log(`PIN reset code for ${phone}: ${code}`);

    return {
      message,
      code,
    };
  }

  async resetPin(dto: ResetPinDto) {
    if (dto.pin !== dto.confirmPin) {
      throw new BadRequestException('PINs do not match');
    }

    const phone = normalizePhone(dto.phone);
    const nida = normalizeNida(dto.nida);
    const key = this.resetKey('conductor', phone);
    const pending = await this.assertResetCode(key, dto.code);
    if (pending.nida && pending.nida !== nida) {
      throw new UnauthorizedException('Reset code is invalid or expired');
    }

    const user = await this.prisma.user.findFirst({
      where: {
        role: UserRole.CONDUCTOR,
        nida,
        phone: { in: phoneLookupValues(phone) },
      },
    });
    if (!user) {
      throw new UnauthorizedException('Account not found');
    }

    const passwordHash = await bcrypt.hash(dto.pin, 12);
    await this.replaceCredential(user.id, passwordHash);
    this.resetCodes.delete(key);

    return {
      message: 'PIN reset successful',
      username: user.username,
    };
  }

  private resetKey(kind: 'agent' | 'conductor', id: string): string {
    return `${kind}:${id}`;
  }

  private async assertResetCode(
    key: string,
    code: string,
  ): Promise<{ hash: string; expiresAt: number; nida?: string; attempts: number }> {
    const pending = this.resetCodes.get(key);
    if (!pending || pending.expiresAt <= Date.now()) {
      this.resetCodes.delete(key);
      throw new UnauthorizedException('Reset code is invalid or expired');
    }

    const matches = await bcrypt.compare(code, pending.hash);
    if (!matches) {
      const attempts = pending.attempts + 1;
      if (attempts >= MAX_RESET_ATTEMPTS) {
        this.resetCodes.delete(key);
        throw new UnauthorizedException('Reset code is invalid or expired');
      }
      pending.attempts = attempts;
      throw new UnauthorizedException('Reset code is invalid or expired');
    }

    return pending;
  }

  private async replaceCredential(
    userId: string,
    passwordHash: string,
  ): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        failedLoginAttempts: 0,
        lockedUntil: null,
        mustChangePassword: false,
      },
    });
  }

  private async issueSession(user: {
    id: string;
    username: string;
    firstName: string;
    lastName: string;
    phone: string;
    email: string | null;
    role: UserRole;
    tillNumber: string | null;
    mustChangePassword?: boolean;
    profilePhotoKey?: string | null;
    profilePhotoUpdatedAt?: Date | null;
  }) {
    await this.setLockout(user.id, 0, null);
    if (user.role === UserRole.CONDUCTOR) {
      await this.ensureConductorTerminal(user.id);
    }

    // Bump session so a login on a new phone invalidates the previous device.
    const refreshed = await this.prisma.user.update({
      where: { id: user.id },
      data: { sessionVersion: { increment: 1 } },
      select: { sessionVersion: true },
    });

    const accessToken = await this.jwtService.signAsync({
      sub: user.id,
      username: user.username,
      role: this.toApiRole(user.role),
      sv: refreshed.sessionVersion,
    });

    if (user.role === UserRole.AGENT) {
      await this.prisma.auditLog.create({
        data: {
          actorUserId: user.id,
          action: 'USER_LOGIN',
          entityType: 'User',
          entityId: user.id,
          metadata: {
            role: 'agent',
            mustChangePassword: Boolean(user.mustChangePassword),
          },
        },
      });
    }

    return {
      message: 'Login successful',
      accessToken,
      user: {
        id: user.id,
        username: user.username,
        firstName: normalizeName(user.firstName),
        lastName: normalizeName(user.lastName),
        phone: user.phone,
        email: user.email,
        role: this.toApiRole(user.role),
        tillNumber: user.tillNumber,
        mustChangePassword: Boolean(user.mustChangePassword),
        permissions: await this.permissionCodes(user),
        profilePhotoUrl: user.profilePhotoKey ? '/auth/profile/photo' : null,
        profilePhotoUpdatedAt: user.profilePhotoUpdatedAt
          ? user.profilePhotoUpdatedAt.toISOString()
          : null,
      },
    };
  }

  private lockoutOf(user: object): {
    failedLoginAttempts: number;
    lockedUntil: Date | null;
  } {
    const record = user as {
      failedLoginAttempts?: unknown;
      lockedUntil?: unknown;
    };
    return {
      failedLoginAttempts:
        typeof record.failedLoginAttempts === 'number'
          ? record.failedLoginAttempts
          : 0,
      lockedUntil:
        record.lockedUntil instanceof Date
          ? record.lockedUntil
          : typeof record.lockedUntil === 'string' ||
              typeof record.lockedUntil === 'number'
            ? new Date(record.lockedUntil)
            : null,
    };
  }

  private async setLockout(
    userId: string,
    failedLoginAttempts: number,
    lockedUntil: Date | null,
  ): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failedLoginAttempts,
        lockedUntil,
      },
    });
  }

  private async registerFailedAttempt(
    userId: string,
    currentAttempts: number,
    kind: 'pin' | 'credentials' = 'pin',
  ): Promise<never> {
    const attempts = currentAttempts + 1;
    if (attempts >= MAX_PIN_ATTEMPTS) {
      const lockedUntil = new Date(Date.now() + LOCKOUT_MS);
      await this.setLockout(userId, attempts, lockedUntil);
      this.throwLocked(lockedUntil);
    }

    await this.setLockout(userId, attempts, null);

    if (kind === 'credentials') {
      throw new UnauthorizedException(BAD_CREDENTIALS);
    }

    const left = MAX_PIN_ATTEMPTS - attempts;
    throw new UnauthorizedException(
      `Wrong PIN. ${left} attempt${left === 1 ? '' : 's'} left.`,
    );
  }

  private throwLocked(lockedUntil: Date): never {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((lockedUntil.getTime() - Date.now()) / 1000),
    );
    const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: `Too many wrong PIN attempts. Try again in ${minutes} minutes.`,
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private toApiRole(role: UserRole): ApiRole {
    if (role === UserRole.ADMIN) return 'admin';
    if (role === UserRole.MASTER_AGENT) return 'master_agent';
    if (role === UserRole.AGENT) return 'agent';
    return 'conductor';
  }

  private async permissionCodes(user: {
    id: string;
    role: UserRole;
  }): Promise<string[]> {
    if (user.role === UserRole.ADMIN) return [...ALL_PERMISSION_CODES];
    if (user.role !== UserRole.MASTER_AGENT) return [];
    const rows = await this.prisma.userPermission.findMany({
      where: { userId: user.id },
      select: { permissionCode: true },
    });
    return rows.map((row) => row.permissionCode);
  }

  private formatTill(nida: string): string {
    const digits = nida.replace(/\D/g, '');
    const padded = digits.padStart(8, '0');
    const lastEight = padded.slice(-8);
    return `${lastEight.slice(0, 4)}-${lastEight.slice(4)}`;
  }

  private async uniqueUsername(
    role: UserRole,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = String(randomInt(100000, 1000000));
      const username =
        role === UserRole.CONDUCTOR
          ? `Bp-c${code}bus`
          : role === UserRole.ADMIN
            ? `Bp-x${code}admin`
            : role === UserRole.MASTER_AGENT
              ? `Bp-m${code}lead`
              : `Bp-a${code}agent`;
      const taken = await db.user.findFirst({
        where: {
          username: {
            equals: username,
            mode: 'insensitive',
          },
        },
      });
      if (!taken) {
        return username;
      }
    }
    throw new ConflictException('Could not generate a unique username');
  }
}

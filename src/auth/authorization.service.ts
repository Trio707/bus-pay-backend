import { ForbiddenException, Injectable } from '@nestjs/common';

import { UserRole, UserStatus, type User } from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import {
  ALL_PERMISSION_CODES,
  isAssignablePermission,
  permissionDefinition,
  type PermissionCode,
} from './permissions';

type Actor = { id: string; role: UserRole };

@Injectable()
export class AuthorizationService {
  constructor(private readonly prisma: PrismaService) {}

  isAdmin(user: { role: UserRole }): boolean {
    return user.role === UserRole.ADMIN;
  }

  async permissionCodes(user: { id: string; role: UserRole }): Promise<string[]> {
    if (user.role === UserRole.ADMIN) return [...ALL_PERMISSION_CODES];
    if (user.role !== UserRole.MASTER_AGENT) return [];
    const rows = await this.prisma.userPermission.findMany({
      where: { userId: user.id },
      select: { permissionCode: true },
    });
    return rows.map((row) => row.permissionCode);
  }

  async hasPermission(user: Actor, code: string): Promise<boolean> {
    if (user.role === UserRole.ADMIN) return true;
    if (user.role !== UserRole.MASTER_AGENT) return false;
    if (!permissionDefinition(code)) return false;
    const row = await this.prisma.userPermission.findUnique({
      where: {
        userId_permissionCode: {
          userId: user.id,
          permissionCode: code,
        },
      },
      select: { userId: true },
    });
    return Boolean(row);
  }

  async requirePermission(user: Actor, code: string): Promise<void> {
    if (await this.hasPermission(user, code)) return;
    throw new ForbiddenException();
  }

  async requireAny(user: Actor, codes: string[]): Promise<void> {
    if (user.role === UserRole.ADMIN) return;
    for (const code of codes) {
      if (await this.hasPermission(user, code)) return;
    }
    throw new ForbiddenException();
  }

  /**
   * Role changes are not a Master Wakala action.
   * A master cannot become ADMIN, create an ADMIN, or edit their own role.
   */
  assertRoleChange(actor: Actor, targetId: string, nextRole: UserRole): void {
    if (actor.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only an admin can change roles');
    }
    if (actor.id === targetId && nextRole !== UserRole.ADMIN) {
      throw new ForbiddenException('You cannot change your own role');
    }
    if (nextRole === UserRole.ADMIN && actor.id === targetId) {
      return;
    }
    if (nextRole === UserRole.ADMIN) {
      throw new ForbiddenException('Promoting a user to admin is not allowed');
    }
  }

  assertCanManageMasterPermissions(actor: Actor, targetId: string): void {
    if (actor.role !== UserRole.ADMIN) {
      throw new ForbiddenException();
    }
    if (actor.id === targetId) {
      throw new ForbiddenException('You cannot change your own permissions');
    }
  }

  assertAssignable(codes: string[]): PermissionCode[] {
    const unique = [...new Set(codes)];
    for (const code of unique) {
      if (!permissionDefinition(code) || !isAssignablePermission(code)) {
        throw new ForbiddenException(
          'That permission is reserved for an admin',
        );
      }
    }
    return unique as PermissionCode[];
  }

  async requireUserList(
    actor: Actor,
    requested?: UserRole,
  ): Promise<void> {
    if (actor.role === UserRole.ADMIN) return;
    if (requested === UserRole.CONDUCTOR) {
      await this.requirePermission(actor, 'CONDUCTOR_VIEW');
      return;
    }
    if (requested === UserRole.AGENT) {
      await this.requirePermission(actor, 'WAKALA_VIEW');
      return;
    }
    throw new ForbiddenException();
  }

  async requireUserRead(actor: Actor, targetRole: UserRole): Promise<void> {
    if (actor.role === UserRole.ADMIN) return;
    if (targetRole === UserRole.AGENT) {
      await this.requirePermission(actor, 'WAKALA_VIEW');
      return;
    }
    if (targetRole === UserRole.CONDUCTOR) {
      await this.requirePermission(actor, 'CONDUCTOR_VIEW');
      return;
    }
    throw new ForbiddenException();
  }

  async requireStatusChange(
    actor: Actor,
    target: User,
    next: UserStatus,
  ): Promise<void> {
    if (actor.role === UserRole.ADMIN) return;
    if (actor.id === target.id) {
      throw new ForbiddenException('You cannot change your own account');
    }
    if (
      target.role === UserRole.ADMIN ||
      target.role === UserRole.MASTER_AGENT
    ) {
      throw new ForbiddenException();
    }
    if (target.role === UserRole.AGENT) {
      await this.requirePermission(
        actor,
        next === UserStatus.SUSPENDED
          ? 'WAKALA_BLOCK'
          : next === UserStatus.ACTIVE
            ? 'WAKALA_UNBLOCK'
            : 'WAKALA_UPDATE',
      );
      return;
    }
    if (target.role === UserRole.CONDUCTOR) {
      await this.requirePermission(
        actor,
        next === UserStatus.SUSPENDED
          ? 'CONDUCTOR_BLOCK'
          : next === UserStatus.ACTIVE
            ? 'CONDUCTOR_UNBLOCK'
            : 'CONDUCTOR_UPDATE',
      );
      return;
    }
    throw new ForbiddenException();
  }
}

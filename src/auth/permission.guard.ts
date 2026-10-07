import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { UserRole, type User } from '../generated/prisma';
import { AuthorizationService } from './authorization.service';
import {
  ANY_PERMISSIONS_KEY,
  PERMISSIONS_KEY,
} from './permissions.decorator';

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorization: AuthorizationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const user = context.switchToHttp().getRequest<{ user?: User }>().user;
    if (!user) {
      throw new ForbiddenException();
    }
    if (user.role === UserRole.ADMIN) return true;
    if (user.role !== UserRole.MASTER_AGENT) {
      throw new ForbiddenException();
    }

    const required = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    const anyOf = this.reflector.getAllAndOverride<string[]>(
      ANY_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (required?.length) {
      for (const code of required) {
        if (!(await this.authorization.hasPermission(user, code))) {
          throw new ForbiddenException();
        }
      }
      return true;
    }

    if (anyOf?.length) {
      await this.authorization.requireAny(user, anyOf);
      return true;
    }

    throw new ForbiddenException();
  }
}

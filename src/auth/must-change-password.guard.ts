import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

import { UserRole } from '../generated/prisma';

@Injectable()
export class MustChangePasswordGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest<{
      user?: { role?: UserRole; mustChangePassword?: boolean };
    }>().user;
    if (
      (user?.role === UserRole.AGENT || user?.role === UserRole.MASTER_AGENT) &&
      user.mustChangePassword
    ) {
      throw new ForbiddenException('Change your password before continuing');
    }
    return true;
  }
}

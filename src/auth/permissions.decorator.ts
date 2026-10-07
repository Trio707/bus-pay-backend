import { SetMetadata, applyDecorators } from '@nestjs/common';

import { UserRole } from '../generated/prisma';
import { Roles } from './roles.decorator';

export const PERMISSIONS_KEY = 'permissions';
export const ANY_PERMISSIONS_KEY = 'any_permissions';

export const Permissions = (...codes: string[]) =>
  SetMetadata(PERMISSIONS_KEY, codes);

export const AnyPermissions = (...codes: string[]) =>
  SetMetadata(ANY_PERMISSIONS_KEY, codes);

/** ADMIN or a MASTER_AGENT who holds every listed permission. */
export function Staff(...codes: string[]) {
  return applyDecorators(
    Roles(UserRole.ADMIN, UserRole.MASTER_AGENT),
    Permissions(...codes),
  );
}

/** ADMIN or a MASTER_AGENT who holds at least one listed permission. */
export function StaffAny(...codes: string[]) {
  return applyDecorators(
    Roles(UserRole.ADMIN, UserRole.MASTER_AGENT),
    AnyPermissions(...codes),
  );
}

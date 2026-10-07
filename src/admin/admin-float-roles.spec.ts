import 'reflect-metadata';
import { UserRole } from '../generated/prisma';
import { ROLES_KEY } from '../auth/roles.decorator';
import { AdminController } from './admin.controller';
import { PlatformController } from '../platform/platform.controller';

describe('float endpoint roles', () => {
  it('keeps wakala funding on the admin controller', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AdminController)).toEqual([
      UserRole.ADMIN,
    ]);
    expect(AdminController.prototype.fundWakalaFloat).toEqual(expect.any(Function));
    expect(
      Object.prototype.hasOwnProperty.call(
        PlatformController.prototype,
        'fundWakalaFloat',
      ),
    ).toBe(false);
  });

  it('lets an agent read float and not fund it', () => {
    expect(
      Reflect.getMetadata(ROLES_KEY, PlatformController.prototype.getFloat),
    ).toEqual([UserRole.AGENT]);
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        PlatformController.prototype.listFloatTransactions,
      ),
    ).toEqual([UserRole.AGENT]);
  });
});

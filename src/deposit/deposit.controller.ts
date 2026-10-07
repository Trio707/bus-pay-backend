import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { PermissionGuard } from '../auth/permission.guard'
import { PermissionCode } from '../auth/permissions'
import { Staff } from '../auth/permissions.decorator'
import { Roles } from '../auth/roles.decorator'
import { RolesGuard } from '../auth/roles.guard'
import { UserRole, WalletDepositStatus } from '../generated/prisma'
import { DepositService } from './deposit.service'

@Controller('admin/deposits')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
@Roles(UserRole.ADMIN)
export class DepositAdminController {
  constructor(private readonly deposits: DepositService) {}

  @Get()
  @Staff(PermissionCode.MOBILE_MONEY_VIEW)
  list(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ) {
    const allowed = Object.values(WalletDepositStatus) as string[]
    const parsed = status && allowed.includes(status) ? (status as WalletDepositStatus) : undefined
    return this.deposits.listForAdmin(Number(page ?? 1), Number(limit ?? 50), parsed)
  }

  @Get(':id')
  @Staff(PermissionCode.MOBILE_MONEY_VIEW)
  getOne(@Param('id') id: string) {
    return this.deposits.getForAdmin(id)
  }
}

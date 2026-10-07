import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common'
import { CurrentUser } from '../auth/current-user.decorator'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { PermissionGuard } from '../auth/permission.guard'
import { PermissionCode } from '../auth/permissions'
import { Staff } from '../auth/permissions.decorator'
import { Roles } from '../auth/roles.decorator'
import { RolesGuard } from '../auth/roles.guard'
import { UserRole, type User } from '../generated/prisma'
import { COMPANY_EXPENSE_ACCOUNTS } from './accounts'
import { CompanyFinanceService } from './company-finance.service'

@Controller('admin/financial')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
@Roles(UserRole.ADMIN)
export class CompanyFinanceController {
  constructor(private readonly company: CompanyFinanceService) {}

  @Get('company-position')
  @Staff(PermissionCode.FINANCIAL_COMPANY_VIEW)
  position() {
    return this.company.position()
  }

  @Get('customer-funds')
  @Staff(PermissionCode.FINANCIAL_COMPANY_VIEW)
  customerFunds() {
    return this.company.customerFunds()
  }

  @Get('company-banks')
  @Staff(PermissionCode.FINANCIAL_COMPANY_VIEW)
  banks() {
    return this.company.listBanks()
  }

  @Get('company-transactions')
  @Staff(PermissionCode.FINANCIAL_COMPANY_VIEW)
  transactions() {
    return this.company.listTransactions()
  }

  @Post('company-banks')
  createBank(
    @CurrentUser() user: User,
    @Body()
    body: { name: string; bankName?: string; accountNumber: string; accountType?: string },
  ) {
    return this.company.createBank(user.id, body)
  }

  @Post('company-deposits')
  deposit(
    @CurrentUser() user: User,
    @Body()
    body: { amount: number; bankAccountId: string; reference?: string; reason: string; idempotencyKey: string },
  ) {
    return this.company.recordDeposit(user.id, body)
  }

  @Post('company-expenses')
  expense(
    @CurrentUser() user: User,
    @Body()
    body: {
      amount: number
      category: keyof typeof COMPANY_EXPENSE_ACCOUNTS
      bankAccountId: string
      reason: string
      reference?: string
      payee?: string
      idempotencyKey: string
    },
  ) {
    return this.company.recordExpense(user.id, body)
  }

  @Post('company-transfers')
  transfer(
    @CurrentUser() user: User,
    @Body()
    body: {
      amount: number
      fromBankAccountId: string
      toBankAccountId: string
      reason: string
      idempotencyKey: string
    },
  ) {
    return this.company.recordTransfer(user.id, body)
  }

  @Post('company-adjustments')
  adjustment(
    @CurrentUser() user: User,
    @Body()
    body: {
      amount: number
      debitAccountCode: string
      creditAccountCode: string
      reason: string
      reference: string
      idempotencyKey: string
    },
  ) {
    return this.company.recordAdjustment(user.id, body)
  }

  @Post('company-distributions')
  distribute(
    @CurrentUser() user: User,
    @Body()
    body: { amount: number; destination: string; reason: string; bankAccountId: string; idempotencyKey: string },
  ) {
    return this.company.requestDistribution(user.id, body)
  }

  @Post('company-distributions/:id/approve')
  approve(@CurrentUser() user: User, @Param('id') id: string) {
    return this.company.approveDistribution(user.id, id)
  }

  @Post('company-distributions/:id/reject')
  reject(@CurrentUser() user: User, @Param('id') id: string, @Body() body: { reason: string }) {
    return this.company.rejectDistribution(user.id, id, body.reason)
  }

  @Post('company-opening-balance')
  opening(@CurrentUser() user: User, @Body() body: { amount: number; bankAccountId?: string }) {
    return this.company.postOpeningCash(user.id, body)
  }
}

import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MustChangePasswordGuard } from '../auth/must-change-password.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { PermissionCode, PERMISSION_CATALOG } from '../auth/permissions';
import { Staff, StaffAny } from '../auth/permissions.decorator';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { ConductorPayoutStatus, UserRole, type User } from '../generated/prisma';
import { FinancialReportService } from '../financial/financial-report.service';
import { CompanyFinanceService } from '../financial/company-finance.service';
import { OpeningBalanceService } from '../financial/opening-balance.service';
import { financialRailStatus, toExternalTransaction } from '../financial/financial-rail';
import { ConductorPayoutService } from '../payout/conductor-payout.service';
import { ProfilePhotoService } from '../profile-photo/profile-photo.service';
import { sendProfilePhoto } from '../profile-photo/send-profile-photo';
import { TestEmailDto } from '../email/dto/test-email.dto';
import { AdminService } from './admin.service';
import {
  AssignTerminalDto,
  BulkInventoryDto,
  CreateConductorDto,
  CreateSettlementDto,
  ListAlertsQueryDto,
  ListAuditLogsQueryDto,
  ListCardsQueryDto,
  ListCustomersQueryDto,
  ListInventoryQueryDto,
  ListRefundsQueryDto,
  ListSettlementsQueryDto,
  ListTopUpsQueryDto,
  ListTransactionsQueryDto,
  ListUsersQueryDto,
  ListWalletsQueryDto,
  ListWithdrawalsQueryDto,
  FundWakalaFloatDto,
  PaginationQueryDto,
  ReplaceCardDto,
  ReportsQueryDto,
  ReverseTransactionDto,
  UpdateCustomerStatusDto,
  UpdateSettingsDto,
  UpdateUserStatusDto,
  WithdrawalDecisionDto,
  CreateMasterWakalaDto,
  SetMasterPermissionsDto,
  UpdateMasterWakalaDto,
} from './dto/admin.dto';

@Controller('admin')
@UseGuards(JwtAuthGuard, MustChangePasswordGuard, RolesGuard, PermissionGuard)
@Roles(UserRole.ADMIN)
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly payouts: ConductorPayoutService,
    private readonly financialReports: FinancialReportService,
    private readonly openingBalances: OpeningBalanceService,
    private readonly companyFinance: CompanyFinanceService,
    private readonly photos: ProfilePhotoService,
  ) {}

  @Get('users/:id/profile-photo')
  async userProfilePhoto(
    @Param('id') id: string,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() res: Response,
  ) {
    const result = await this.photos.readForAdmin(id, ifNoneMatch);
    sendProfilePhoto(res, result);
  }

  @Get('overview')
  @Staff(PermissionCode.DASHBOARD_VIEW)
  overview() {
    return this.adminService.overview();
  }

  @Get('users')
  @StaffAny(PermissionCode.WAKALA_VIEW, PermissionCode.CONDUCTOR_VIEW)
  listUsers(@CurrentUser() actor: User, @Query() query: ListUsersQueryDto) {
    return this.adminService.listUsers(query, actor);
  }

  @Get('users/:id')
  @StaffAny(PermissionCode.WAKALA_VIEW, PermissionCode.CONDUCTOR_VIEW)
  getUser(@CurrentUser() actor: User, @Param('id') id: string) {
    return this.adminService.getUser(id, actor);
  }

  @Post('conductors')
  @Staff(PermissionCode.CONDUCTOR_CREATE)
  createConductor(
    @CurrentUser() user: User,
    @Body() dto: CreateConductorDto,
  ) {
    return this.adminService.createConductor(user, dto);
  }

  @Patch('users/:id/status')
  @StaffAny(
    PermissionCode.WAKALA_BLOCK,
    PermissionCode.WAKALA_UNBLOCK,
    PermissionCode.WAKALA_UPDATE,
    PermissionCode.CONDUCTOR_BLOCK,
    PermissionCode.CONDUCTOR_UNBLOCK,
    PermissionCode.CONDUCTOR_UPDATE,
  )
  updateUserStatus(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: UpdateUserStatusDto,
  ) {
    return this.adminService.updateUserStatus(user, id, dto);
  }

  @Post('users/:id/unlock')
  unlockUser(@CurrentUser() user: User, @Param('id') id: string) {
    return this.adminService.unlockUser(user, id);
  }

  @Get('wakala/:id/float')
  @Staff(PermissionCode.WAKALA_VIEW)
  getWakalaFloat(@Param('id') id: string) {
    return this.adminService.getWakalaFloat(id);
  }

  @Get('wakala/:id/float/transactions')
  @Staff(PermissionCode.WAKALA_VIEW)
  listWakalaFloatTransactions(
    @Param('id') id: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.adminService.listWakalaFloatTransactions(id, query);
  }

  @Post('wakala/:id/float/fund')
  fundWakalaFloat(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: FundWakalaFloatDto,
  ) {
    return this.adminService.fundWakalaFloat(user, id, dto);
  }

  @Get('customers')
  listCustomers(@Query() query: ListCustomersQueryDto) {
    return this.adminService.listCustomers(query);
  }

  @Get('customers/:id')
  getCustomer(@Param('id') id: string) {
    return this.adminService.getCustomer(id);
  }

  @Patch('customers/:id/status')
  updateCustomerStatus(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: UpdateCustomerStatusDto,
  ) {
    return this.adminService.updateCustomerStatus(user, id, dto);
  }

  @Get('terminals')
  @Staff(PermissionCode.CONDUCTOR_VIEW)
  listTerminals(@Query() query: PaginationQueryDto) {
    return this.adminService.listTerminals(query);
  }

  @Post('terminals/:terminalId/assign')
  assignTerminal(
    @CurrentUser() user: User,
    @Param('terminalId') terminalId: string,
    @Body() dto: AssignTerminalDto,
  ) {
    return this.adminService.assignTerminal(user, terminalId, dto);
  }

  @Get('cards')
  @Staff(PermissionCode.CARD_VIEW)
  listCards(@Query() query: ListCardsQueryDto) {
    return this.adminService.listCards(query);
  }

  @Get('cards/inventory')
  @Staff(PermissionCode.CARD_VIEW)
  listInventory(@Query() query: ListInventoryQueryDto) {
    return this.adminService.listInventory(query);
  }

  @Post('cards/inventory')
  addInventory(
    @CurrentUser() user: User,
    @Body() dto: BulkInventoryDto,
  ) {
    return this.adminService.addInventory(user, dto);
  }

  @Get('cards/:serial')
  @Staff(PermissionCode.CARD_VIEW)
  getCard(@Param('serial') serial: string) {
    return this.adminService.getCard(serial);
  }

  @Post('cards/:serial/freeze')
  freezeCard(
    @CurrentUser() user: User,
    @Param('serial') serial: string,
  ) {
    return this.adminService.freezeCard(user, serial);
  }

  @Post('cards/:serial/unfreeze')
  unfreezeCard(
    @CurrentUser() user: User,
    @Param('serial') serial: string,
  ) {
    return this.adminService.unfreezeCard(user, serial);
  }

  @Post('cards/:serial/replace')
  @Staff(PermissionCode.CARD_REPLACE)
  replaceCard(
    @CurrentUser() user: User,
    @Param('serial') serial: string,
    @Body() dto: ReplaceCardDto,
  ) {
    return this.adminService.replaceCard(user, serial, dto);
  }

  @Get('wallets')
  listWallets(@Query() query: ListWalletsQueryDto) {
    return this.adminService.listWallets(query);
  }

  @Get('wallets/:id')
  getWallet(@Param('id') id: string) {
    return this.adminService.getWallet(id);
  }

  @Post('wallets/:id/freeze')
  freezeWallet(@CurrentUser() user: User, @Param('id') id: string) {
    return this.adminService.freezeWallet(user, id);
  }

  @Post('wallets/:id/unfreeze')
  unfreezeWallet(@CurrentUser() user: User, @Param('id') id: string) {
    return this.adminService.unfreezeWallet(user, id);
  }

  @Get('transactions')
  listTransactions(@Query() query: ListTransactionsQueryDto) {
    return this.adminService.listTransactions(query);
  }

  @Post('transactions/:id/reverse')
  reverseTransaction(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: ReverseTransactionDto,
  ) {
    return this.adminService.reverseTransaction(user, id, dto);
  }

  @Get('topups')
  listTopUps(@Query() query: ListTopUpsQueryDto) {
    return this.adminService.listTopUps(query);
  }

  @Get('withdrawals')
  @Staff(PermissionCode.PAYOUT_VIEW)
  listWithdrawals(@Query() query: ListWithdrawalsQueryDto) {
    return this.adminService.listWithdrawals(query);
  }

  @Get('financial/accounts')
  @Staff(PermissionCode.FINANCIAL_LEDGER_VIEW)
  financialAccounts() {
    return this.financialReports.accounts();
  }

  @Get('financial/ledger')
  @Staff(PermissionCode.FINANCIAL_LEDGER_VIEW)
  financialLedger(@Query('page') page?: string, @Query('limit') limit?: string) {
    return this.financialReports.ledger(Number(page ?? 1), Number(limit ?? 50));
  }

  @Get('financial/revenue')
  @Staff(PermissionCode.FINANCIAL_REVENUE_VIEW)
  financialRevenue() {
    return this.financialReports.revenue();
  }

  @Get('financial/expenses')
  @Staff(PermissionCode.FINANCIAL_REVENUE_VIEW)
  financialExpenses() {
    return this.financialReports.expenses();
  }

  @Get('financial/profitability')
  @Staff(PermissionCode.FINANCIAL_REVENUE_VIEW)
  financialProfitability() {
    return this.financialReports.profitability();
  }

  @Get('financial/wakala-commissions')
  @Staff(PermissionCode.FINANCIAL_COMMISSION_VIEW)
  wakalaCommissions() {
    return this.financialReports.wakalaCommissions();
  }

  @Post('financial/wakala-commissions/:agentUserId/settle')
  settleWakalaCommission(@Param('agentUserId') agentUserId: string) {
    return this.financialReports.settleWakala(agentUserId);
  }

  @Get('financial/reconciliation')
  @Staff(PermissionCode.FINANCIAL_RECONCILIATION_VIEW)
  async financialReconciliation() {
    const opening = await this.openingBalances.reconciliation();
    const company = await this.companyFinance.cashReconciliation();
    return { ...opening, accounts: [...opening.accounts, ...company] };
  }

  @Post('financial/opening-balances')
  postOpeningBalances(@CurrentUser() user: User) {
    return this.openingBalances.apply(user.id);
  }

  @Get('financial/status')
  @Staff(PermissionCode.DASHBOARD_VIEW)
  financialStatus() {
    return financialRailStatus();
  }

  @Get('financial/transactions')
  @Staff(PermissionCode.FINANCIAL_LEDGER_VIEW)
  async financialTransactions(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const listed = await this.payouts.listForAdmin(Number(page ?? 1), Number(limit ?? 50));
    return {
      page: listed.page,
      limit: listed.limit,
      total: listed.total,
      rail: financialRailStatus(),
      transactions: listed.payouts.map(toExternalTransaction),
    };
  }

  @Get('payouts')
  @Staff(PermissionCode.PAYOUT_VIEW)
  listPayouts(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ) {
    const allowed = Object.values(ConductorPayoutStatus) as string[];
    const parsed = status && allowed.includes(status) ? (status as ConductorPayoutStatus) : undefined;
    return this.payouts.listForAdmin(Number(page ?? 1), Number(limit ?? 50), parsed);
  }

  @Post('withdrawals/:id/approve')
  approveWithdrawal(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: WithdrawalDecisionDto,
  ) {
    return this.adminService.approveWithdrawal(user, id, dto);
  }

  @Post('withdrawals/:id/reject')
  rejectWithdrawal(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: WithdrawalDecisionDto,
  ) {
    return this.adminService.rejectWithdrawal(user, id, dto);
  }

  @Post('withdrawals/:id/paid')
  markWithdrawalPaid(@CurrentUser() user: User, @Param('id') id: string) {
    return this.adminService.markWithdrawalPaid(user, id);
  }

  @Get('refunds')
  listRefunds(@Query() query: ListRefundsQueryDto) {
    return this.adminService.listRefunds(query);
  }

  @Get('settlements')
  listSettlements(@Query() query: ListSettlementsQueryDto) {
    return this.adminService.listSettlements(query);
  }

  @Post('settlements')
  createSettlement(
    @CurrentUser() user: User,
    @Body() dto: CreateSettlementDto,
  ) {
    return this.adminService.createSettlement(user, dto);
  }

  @Post('settlements/:id/finalize')
  finalizeSettlement(@CurrentUser() user: User, @Param('id') id: string) {
    return this.adminService.finalizeSettlement(user, id);
  }

  @Post('settlements/:id/paid')
  markSettlementPaid(@CurrentUser() user: User, @Param('id') id: string) {
    return this.adminService.markSettlementPaid(user, id);
  }

  @Get('reports/summary')
  @StaffAny(PermissionCode.REPORT_WAKALA_VIEW, PermissionCode.REPORT_CONDUCTOR_VIEW)
  reportsSummary(@Query() query: ReportsQueryDto) {
    return this.adminService.reportsSummary(query);
  }

  @Get('alerts')
  @Staff(PermissionCode.DASHBOARD_VIEW)
  listAlerts(@Query() query: ListAlertsQueryDto) {
    return this.adminService.listAlerts(query);
  }

  @Post('alerts/sync')
  syncAlerts() {
    return this.adminService.syncAlerts();
  }

  @Post('alerts/:id/ack')
  acknowledgeAlert(@CurrentUser() user: User, @Param('id') id: string) {
    return this.adminService.acknowledgeAlert(user, id);
  }

  @Get('settings')
  @Staff(PermissionCode.SYSTEM_SETTINGS_VIEW)
  getSettings() {
    return this.adminService.getSettings();
  }

  @Patch('settings')
  @Staff(PermissionCode.SYSTEM_SETTINGS_UPDATE)
  updateSettings(
    @CurrentUser() user: User,
    @Body() dto: UpdateSettingsDto,
  ) {
    return this.adminService.updateSettings(user, dto);
  }

  @Get('audit-logs')
  @Staff(PermissionCode.AUDIT_LOG_VIEW)
  listAuditLogs(@Query() query: ListAuditLogsQueryDto) {
    return this.adminService.listAuditLogs(query);
  }

  @Get('health')
  @Staff(PermissionCode.DASHBOARD_VIEW)
  health() {
    return this.adminService.health();
  }

  @Get('permissions')
  @Roles(UserRole.ADMIN)
  permissionCatalog() {
    return { permissions: PERMISSION_CATALOG };
  }

  @Get('master-wakala')
  @Roles(UserRole.ADMIN)
  listMasterWakala(@CurrentUser() user: User) {
    return this.adminService.listMasterWakala(user);
  }

  @Post('master-wakala')
  @Roles(UserRole.ADMIN)
  createMasterWakala(
    @CurrentUser() user: User,
    @Body() dto: CreateMasterWakalaDto,
  ) {
    return this.adminService.createMasterWakala(user, dto);
  }

  @Get('master-wakala/:id')
  @Roles(UserRole.ADMIN)
  getMasterWakala(@CurrentUser() user: User, @Param('id') id: string) {
    return this.adminService.getMasterWakala(user, id);
  }

  @Patch('master-wakala/:id')
  @Roles(UserRole.ADMIN)
  updateMasterWakala(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: UpdateMasterWakalaDto,
  ) {
    return this.adminService.updateMasterWakala(user, id, dto);
  }

  @Post('master-wakala/:id/block')
  @Roles(UserRole.ADMIN)
  blockMasterWakala(@CurrentUser() user: User, @Param('id') id: string) {
    return this.adminService.blockMasterWakala(user, id);
  }

  @Post('master-wakala/:id/unblock')
  @Roles(UserRole.ADMIN)
  unblockMasterWakala(@CurrentUser() user: User, @Param('id') id: string) {
    return this.adminService.unblockMasterWakala(user, id);
  }

  @Post('master-wakala/:id/deactivate')
  @Roles(UserRole.ADMIN)
  deactivateMasterWakala(@CurrentUser() user: User, @Param('id') id: string) {
    return this.adminService.deactivateMasterWakala(user, id);
  }

  @Post('email/test')
  @Roles(UserRole.ADMIN)
  sendTestEmail(@CurrentUser() user: User, @Body() dto: TestEmailDto) {
    return this.adminService.sendTestEmail(user, dto.to);
  }

  @Post('master-wakala/:id/credentials')
  @Roles(UserRole.ADMIN)
  resendMasterCredentials(@CurrentUser() user: User, @Param('id') id: string) {
    return this.adminService.resendMasterCredentials(user, id);
  }

  @Put('master-wakala/:id/permissions')
  @Roles(UserRole.ADMIN)
  setMasterPermissions(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: SetMasterPermissionsDto,
  ) {
    return this.adminService.setMasterPermissions(user, id, dto.permissions);
  }
}

import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MustChangePasswordGuard } from '../auth/must-change-password.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { UserRole, type User } from '../generated/prisma';
import {
  ActivateCardDto,
  ConductorWithdrawDto,
  IssueCardDto,
  RenewCardDto,
  ReplaceCardDto,
  ScanCardDto,
  TapPaymentDto,
  TillLookupDto,
  TopUpDto,
} from './dto/platform.dto';
import { PlatformService } from './platform.service';

@Controller('platform')
@UseGuards(JwtAuthGuard, MustChangePasswordGuard, RolesGuard)
export class PlatformController {
  constructor(private readonly platformService: PlatformService) {}

  @Post('cards/scan')
  @Roles(UserRole.AGENT)
  previewScan(@Body() dto: ScanCardDto) {
    return this.platformService.previewScan(dto);
  }

  /** Top-up: scan D-Card → passenger name + card number for wakala UI. */
  @Post('wallets/topup/scan')
  @Roles(UserRole.AGENT)
  previewTopUpScan(@Body() dto: ScanCardDto) {
    return this.platformService.previewTopUpScan(dto);
  }

  /** Recommended: names + cardNumber + nfcUid → activate wallet (no money). */
  @Post('cards/activate')
  @Roles(UserRole.AGENT)
  activateCard(@CurrentUser() user: User, @Body() dto: ActivateCardDto) {
    return this.platformService.activateCard(dto, user);
  }

  /** One-shot or legacy: activate (+ optional initialLoad). */
  @Post('cards')
  @Roles(UserRole.AGENT)
  issueCard(@CurrentUser() user: User, @Body() dto: IssueCardDto) {
    return this.platformService.issueCard(dto, user);
  }

  @Get('cards/uid/:nfcUid')
  lookupByUid(@Param('nfcUid') nfcUid: string) {
    return this.platformService.lookupCard(undefined, nfcUid);
  }

  @Get('cards/:serial')
  lookupCard(@Param('serial') serial: string) {
    return this.platformService.lookupCard(serial);
  }

  @Get('transactions')
  getTransactions(
    @CurrentUser() user: User,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('since') since?: string,
    @Query('summary') summary?: string,
  ) {
    return this.platformService.getTransactions(user, {
      limit,
      cursor,
      since,
      summary,
    });
  }

  @Post('cards/:serial/freeze')
  @Roles(UserRole.ADMIN, UserRole.AGENT)
  freezeCard(@Param('serial') serial: string) {
    return this.platformService.freezeCard(serial);
  }

  @Post('cards/:serial/replace')
  @Roles(UserRole.ADMIN, UserRole.AGENT)
  replaceCard(
    @Param('serial') serial: string,
    @Body() dto: ReplaceCardDto,
  ) {
    return this.platformService.replaceCard(serial, dto);
  }

  @Post('cards/:serial/renew')
  @Roles(UserRole.AGENT)
  renewCard(
    @CurrentUser() user: User,
    @Param('serial') serial: string,
    @Body() dto: RenewCardDto,
  ) {
    return this.platformService.renewCard(serial, dto, user);
  }

  @Post('payments/tap')
  @Roles(UserRole.CONDUCTOR)
  tap(@CurrentUser() user: User, @Body() dto: TapPaymentDto) {
    return this.platformService.tap(user, dto);
  }

  /** Conductor cash-out: wakala TILL + amount. */
  @Post('withdrawals')
  @Roles(UserRole.CONDUCTOR)
  withdrawToWakala(
    @CurrentUser() user: User,
    @Body() dto: ConductorWithdrawDto,
  ) {
    return this.platformService.withdrawToWakala(user, dto);
  }

  /** Preview wakala by TILL before cash-out. */
  @Post('agents/till/lookup')
  @Roles(UserRole.CONDUCTOR)
  lookupWakalaTill(@Body() dto: TillLookupDto) {
    return this.platformService.lookupWakalaTill(dto.tillNumber);
  }

  @Post('wallets/topup')
  @Roles(UserRole.AGENT)
  topUp(@CurrentUser() user: User, @Body() dto: TopUpDto) {
    return this.platformService.topUp(user, dto);
  }

  @Get('float')
  @Roles(UserRole.AGENT)
  getFloat(@CurrentUser() user: User) {
    return this.platformService.getFloat(user);
  }

  @Get('float/transactions')
  @Roles(UserRole.AGENT)
  listFloatTransactions(
    @CurrentUser() user: User,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.platformService.listFloatTransactions(user, page, limit);
  }
}

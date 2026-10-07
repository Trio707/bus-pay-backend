import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MustChangePasswordGuard } from '../auth/must-change-password.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { UserRole, type User } from '../generated/prisma';
import { ConductorPayoutService } from './conductor-payout.service';
import { CreateConductorPayoutDto } from './dto/create-payout.dto';

@Controller('platform/conductor/payouts')
@UseGuards(JwtAuthGuard, MustChangePasswordGuard, RolesGuard)
export class ConductorPayoutController {
  constructor(private readonly payouts: ConductorPayoutService) {}

  @Post()
  @Roles(UserRole.CONDUCTOR)
  request(@CurrentUser() user: User, @Body() dto: CreateConductorPayoutDto) {
    return this.payouts.request(user, dto);
  }

  @Get()
  @Roles(UserRole.CONDUCTOR)
  list(@CurrentUser() user: User) {
    return this.payouts.listMine(user);
  }

  /** Fee preview. The amount is what the conductor receives. Nothing is reserved. */
  @Get('quote')
  @Roles(UserRole.CONDUCTOR)
  quote(@Query('amount') amount?: string) {
    return this.payouts.quote(Number(amount));
  }

  @Get(':id')
  @Roles(UserRole.CONDUCTOR)
  getOne(@CurrentUser() user: User, @Param('id') id: string) {
    return this.payouts.getMine(user, id);
  }
}

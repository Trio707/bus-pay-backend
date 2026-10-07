import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';

import { UserRole, type User } from '../generated/prisma';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';
import { AuthService } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import { AgentForgotPasswordDto } from './dto/agent-forgot-password.dto';
import { AgentLoginDto } from './dto/agent-login.dto';
import { AgentResetPasswordDto } from './dto/agent-reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ChangePinDto } from './dto/change-pin.dto';
import { CreateWakalaDto } from './dto/create-wakala.dto';
import { ForgotPinDto } from './dto/forgot-pin.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPinDto } from './dto/reset-pin.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PermissionGuard } from './permission.guard';
import { Permissions } from './permissions.decorator';
import { PermissionCode } from './permissions';
import { Roles } from './roles.decorator';
import { RolesGuard } from './roles.guard';

@Controller('auth')
@UseGuards(AuthRateLimitGuard)
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register/conductor')
  registerConductor(@Body() dto: RegisterDto) {
    return this.authService.registerConductor(dto);
  }

  @Post('admin/login')
  loginAdmin(@Body() dto: AgentLoginDto) {
    return this.authService.loginAdmin(dto);
  }

  @Get('admin/session')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.MASTER_AGENT)
  dashboardSession(@CurrentUser() user: User) {
    return this.authService.dashboardSession(user);
  }

  @Post('admin/change-password')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.MASTER_AGENT)
  changeDashboardPassword(
    @CurrentUser() user: User,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changeDashboardPassword(user, dto);
  }

  @Post('admin/wakala')
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
  @Roles(UserRole.ADMIN, UserRole.MASTER_AGENT)
  @Permissions(PermissionCode.WAKALA_CREATE)
  createWakala(
    @CurrentUser() user: User,
    @Body() dto: CreateWakalaDto,
  ) {
    return this.authService.createWakala(dto, user);
  }

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('agent/login')
  loginAgent(@Body() dto: AgentLoginDto) {
    return this.authService.loginAgent(dto);
  }

  @Post('agent/forgot-password')
  forgotAgentPassword(@Body() dto: AgentForgotPasswordDto) {
    return this.authService.forgotAgentPassword(dto);
  }

  @Post('agent/reset-password')
  resetAgentPassword(@Body() dto: AgentResetPasswordDto) {
    return this.authService.resetAgentPassword(dto);
  }

  @Post('agent/change-password')
  @UseGuards(JwtAuthGuard)
  changeAgentPassword(
    @CurrentUser() user: User,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changeAgentPassword(user, dto);
  }

  @Post('change-pin')
  @UseGuards(JwtAuthGuard)
  changePin(@CurrentUser() user: User, @Body() dto: ChangePinDto) {
    return this.authService.changePin(user, dto);
  }

  @Post('forgot-pin')
  forgotPin(@Body() dto: ForgotPinDto) {
    return this.authService.forgotPin(dto);
  }

  @Post('reset-pin')
  resetPin(@Body() dto: ResetPinDto) {
    return this.authService.resetPin(dto);
  }
}

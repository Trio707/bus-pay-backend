import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { PrismaModule } from '../prisma/prisma.module';
import { SmsModule } from '../sms/sms.module';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtStrategy } from './jwt.strategy';
import { AuthorizationService } from './authorization.service';
import { PermissionGuard } from './permission.guard';
import { RolesGuard } from './roles.guard';

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  throw new Error('JWT_SECRET is not set');
}

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => SmsModule),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({
      secret: jwtSecret,
      signOptions: {
        expiresIn: '1d',
      },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthRateLimitGuard,
    JwtStrategy,
    JwtAuthGuard,
    RolesGuard,
    AuthorizationService,
    PermissionGuard,
  ],
  exports: [
    AuthService,
    AuthRateLimitGuard,
    JwtAuthGuard,
    RolesGuard,
    AuthorizationService,
    PermissionGuard,
    PassportModule,
  ],
})
export class AuthModule {}

import { Type } from 'class-transformer';
import {
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import { EmailField } from '../../auth/email';

import {
  NIDA_MESSAGE,
  NIDA_PATTERN,
  NidaField,
  TZ_PHONE_MESSAGE,
  TZ_PHONE_PATTERN,
  PhoneField,
} from '../../auth/identity';
import {
  AlertStatus,
  CardInventoryStatus,
  CardStatus,
  TransactionStatus,
  UserRole,
  UserStatus,
  WalletStatus,
  WithdrawalStatus,
} from '../../generated/prisma';

export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 50;
}

export class ListUsersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn([UserRole.ADMIN, UserRole.AGENT, UserRole.CONDUCTOR, UserRole.MASTER_AGENT])
  role?: UserRole;

  @IsOptional()
  @IsIn([UserStatus.ACTIVE, UserStatus.INACTIVE, UserStatus.SUSPENDED])
  status?: UserStatus;

  @IsOptional()
  @IsString()
  q?: string;
}

export class CreateConductorDto {
  @IsString()
  @IsNotEmpty()
  firstName: string;

  @IsString()
  @IsNotEmpty()
  lastName: string;

  @PhoneField()
  @IsString()
  @Matches(TZ_PHONE_PATTERN, { message: TZ_PHONE_MESSAGE })
  phone: string;

  @NidaField()
  @IsString()
  @Matches(NIDA_PATTERN, { message: NIDA_MESSAGE })
  nida: string;

  @IsString()
  @Matches(/^\d{4}$/, { message: 'PIN must be exactly 4 digits' })
  pin: string;
}

export class UpdateUserStatusDto {
  @IsIn([UserStatus.ACTIVE, UserStatus.INACTIVE, UserStatus.SUSPENDED])
  status: UserStatus;
}

export class AssignTerminalDto {
  @IsUUID()
  conductorUserId: string;
}

export class ListCardsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn([
    CardStatus.ACTIVE,
    CardStatus.FROZEN,
    CardStatus.REPLACED,
    CardStatus.LOST,
    CardStatus.DAMAGED,
  ])
  status?: CardStatus;

  @IsOptional()
  @IsString()
  q?: string;
}

export class ReplaceCardDto {
  @IsOptional()
  @IsString()
  serialNumber?: string;

  @IsOptional()
  @IsString()
  nfcUid?: string;
}

export class ListWalletsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn([WalletStatus.ACTIVE, WalletStatus.FROZEN, WalletStatus.CLOSED])
  status?: WalletStatus;

  @IsOptional()
  @IsString()
  q?: string;
}

export class ListTransactionsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @IsIn([
    TransactionStatus.PENDING,
    TransactionStatus.SUCCESS,
    TransactionStatus.FAILED,
    TransactionStatus.REVERSED,
  ])
  status?: TransactionStatus;

  @IsOptional()
  @IsUUID()
  terminalId?: string;

  @IsOptional()
  @IsString()
  q?: string;
}

export class ListTopUpsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @IsUUID()
  agentUserId?: string;

  @IsOptional()
  @IsString()
  q?: string;
}

export class ListAuditLogsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @IsOptional()
  @IsString()
  action?: string;
}

export class ListCustomersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn([UserStatus.ACTIVE, UserStatus.INACTIVE, UserStatus.SUSPENDED])
  status?: UserStatus;

  @IsOptional()
  @IsString()
  q?: string;
}

export class UpdateCustomerStatusDto {
  @IsIn([UserStatus.ACTIVE, UserStatus.INACTIVE, UserStatus.SUSPENDED])
  status: UserStatus;
}

export class ListWithdrawalsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn([
    WithdrawalStatus.PENDING,
    WithdrawalStatus.APPROVED,
    WithdrawalStatus.PAID,
    WithdrawalStatus.REJECTED,
  ])
  status?: WithdrawalStatus;

  @IsOptional()
  @IsString()
  q?: string;
}

export class WithdrawalDecisionDto {
  @IsOptional()
  @IsString()
  notes?: string;
}

export class ReverseTransactionDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

export class CreateSettlementDto {
  @IsString()
  @IsNotEmpty()
  periodStart: string;

  @IsString()
  @IsNotEmpty()
  periodEnd: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  feeBps?: number;
}

export class ListSettlementsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  status?: string;
}

export class InventoryItemDto {
  @IsString()
  @IsNotEmpty()
  serialNumber: string;

  @IsOptional()
  @IsString()
  nfcUid?: string;
}

export class BulkInventoryDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InventoryItemDto)
  items: InventoryItemDto[];
}

export class ListInventoryQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn([
    CardInventoryStatus.IN_STOCK,
    CardInventoryStatus.ISSUED,
    CardInventoryStatus.DAMAGED,
  ])
  status?: CardInventoryStatus;

  @IsOptional()
  @IsString()
  q?: string;
}

export class ReportsQueryDto {
  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;
}

export class ListAlertsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn([AlertStatus.OPEN, AlertStatus.ACKED])
  status?: AlertStatus;

  @IsOptional()
  @IsString()
  type?: string;
}

export class UpdateSettingsDto {
  @IsOptional()
  @IsString()
  defaultFare?: string;

  @IsOptional()
  @IsString()
  lockoutMinutes?: string;

  @IsOptional()
  @IsString()
  smsEnabled?: string;

  @IsOptional()
  @IsString()
  settlementFeeBps?: string;
}

export class FundWakalaFloatDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount: number;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  reference?: string;
}

export class ListRefundsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;
}

export class CreateMasterWakalaDto {
  @IsString()
  @IsNotEmpty()
  firstName: string;

  @IsString()
  @IsNotEmpty()
  lastName: string;

  @EmailField()
  @IsEmail({}, { message: 'Use a valid email' })
  email: string;

  @PhoneField()
  @IsString()
  @Matches(TZ_PHONE_PATTERN, { message: TZ_PHONE_MESSAGE })
  phone: string;

  @NidaField()
  @IsString()
  @Matches(NIDA_PATTERN, { message: NIDA_MESSAGE })
  nida: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissions?: string[];
}

export class UpdateMasterWakalaDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  firstName?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  lastName?: string;

  @IsOptional()
  @EmailField()
  @IsEmail({}, { message: 'Use a valid email' })
  email?: string;

  @IsOptional()
  @PhoneField()
  @IsString()
  @Matches(TZ_PHONE_PATTERN, { message: TZ_PHONE_MESSAGE })
  phone?: string;
}

export class SetMasterPermissionsDto {
  @IsArray()
  @IsString({ each: true })
  permissions: string[];
}

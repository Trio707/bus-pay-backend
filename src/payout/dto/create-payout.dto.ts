import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateConductorPayoutDto {
  @IsIn(['MOBILE_MONEY', 'BANK'])
  method: 'MOBILE_MONEY' | 'BANK';

  @IsString()
  @Matches(/^[A-Za-z0-9_-]{2,32}$/)
  provider: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  mobileNumber?: string;

  @IsOptional()
  @IsString()
  @MinLength(6)
  @MaxLength(30)
  @Matches(/^[A-Za-z0-9-]+$/)
  accountNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  accountName?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount: number;

  @IsString()
  @MinLength(8)
  @MaxLength(80)
  @Matches(/^[A-Za-z0-9_-]+$/)
  idempotencyKey: string;
}

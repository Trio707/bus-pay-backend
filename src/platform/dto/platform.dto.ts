import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Matches,
  Min,
  ValidateIf,
} from 'class-validator';

import {
  NIDA_MESSAGE,
  NIDA_PATTERN,
  NidaField,
  PhoneField,
  TZ_PHONE_MESSAGE,
  TZ_PHONE_PATTERN,
} from '../../auth/identity';

export class IssueCardDto {
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

  @IsOptional()
  @ValidateIf((_, value) => value != null && String(value).trim() !== '')
  @NidaField()
  @IsString()
  @Matches(NIDA_PATTERN, { message: NIDA_MESSAGE })
  nida?: string;

  /** Public card number from scan preview (or typed). Alias: cardNumber. */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9]{4,24}$/, {
    message: 'Card number must be 4-24 letters or digits',
  })
  serialNumber?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9]{4,24}$/, {
    message: 'Card number must be 4-24 letters or digits',
  })
  cardNumber?: string;

  /** Required from NFC scanner. */
  @IsString()
  @IsNotEmpty()
  nfcUid: string;

  /**
   * Prefer activate → separate top-up for payment confirmation.
   * Still accepted for one-shot registration.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  initialLoad?: number;
}

/** Step 2: create/activate wallet (no money yet). */
export class ActivateCardDto {
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

  @IsOptional()
  @ValidateIf((_, value) => value != null && String(value).trim() !== '')
  @NidaField()
  @IsString()
  @Matches(NIDA_PATTERN, { message: NIDA_MESSAGE })
  nida?: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Za-z0-9]{4,24}$/, {
    message: 'Card number must be 4-24 letters or digits',
  })
  cardNumber: string;

  @IsString()
  @IsNotEmpty()
  nfcUid: string;
}

export class ScanCardDto {
  @IsString()
  @IsNotEmpty()
  nfcUid: string;
}

export class TapPaymentDto {
  @IsOptional()
  @IsString()
  serialNumber?: string;

  @IsOptional()
  @IsString()
  nfcUid?: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  amount: number;

  @IsOptional()
  @IsString()
  merchantCode?: string;

  @IsOptional()
  @IsString()
  terminalCode?: string;

  @IsOptional()
  @IsString()
  serviceType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(/^[A-Za-z0-9_-]{8,80}$/, {
    message: 'idempotencyKey must be 8-80 letters, digits, _ or -',
  })
  idempotencyKey?: string;
}

export class TopUpDto {
  @IsOptional()
  @IsString()
  serialNumber?: string;

  /** From NFC scanner (preferred for wakala top-up). Not shown in UI. */
  @IsOptional()
  @IsString()
  nfcUid?: string;

  /** Alias for public wallet/card account number (mobile money / M-Pesa). */
  @IsOptional()
  @IsString()
  walletAccountNumber?: string;

  @IsOptional()
  @IsString()
  publicCode?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(/^[A-Za-z0-9_-]{8,80}$/, {
    message: 'idempotencyKey must be 8-80 letters, digits, _ or -',
  })
  idempotencyKey?: string;
}

/** Conductor cash-out at a wakala till. */
export class ConductorWithdrawDto {
  @IsString()
  @IsNotEmpty()
  tillNumber: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(/^[A-Za-z0-9_-]{8,80}$/, {
    message: 'idempotencyKey must be 8-80 letters, digits, _ or -',
  })
  idempotencyKey?: string;
}

export class TillLookupDto {
  @IsString()
  @IsNotEmpty()
  tillNumber: string;
}

export class ReplaceCardDto {
  @IsOptional()
  @IsString()
  serialNumber?: string;

  @IsOptional()
  @IsString()
  nfcUid?: string;
}

export class RenewCardDto {
  @IsOptional()
  @IsString()
  nfcUid?: string;

  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  amount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  initialLoad?: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(/^[A-Za-z0-9_-]{8,80}$/, {
    message: 'idempotencyKey must be 8-80 letters, digits, _ or -',
  })
  idempotencyKey?: string;
}

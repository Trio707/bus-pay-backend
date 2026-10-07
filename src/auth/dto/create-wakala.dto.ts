import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';

import { EmailField } from '../email';
import {
  NIDA_MESSAGE,
  NIDA_PATTERN,
  NidaField,
  TZ_PHONE_MESSAGE,
  TZ_PHONE_PATTERN,
  PhoneField,
} from '../identity';

export class CreateWakalaDto {
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

  /** Ignored when an admin creates the account. A temporary password is generated. */
  @IsOptional()
  @IsString()
  password?: string;
}

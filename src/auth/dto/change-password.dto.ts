import { IsString, Matches, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  currentPassword: string;

  @IsString()
  @MinLength(12)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,}$/, {
    message:
      'Password is too weak. Use at least 12 characters including uppercase, lowercase, number, and special character.',
  })
  password: string;

  @IsString()
  @MinLength(12)
  confirmPassword: string;
}

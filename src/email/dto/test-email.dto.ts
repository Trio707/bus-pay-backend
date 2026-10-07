import { IsEmail } from 'class-validator';

import { EmailField } from '../../auth/email';

export class TestEmailDto {
  @EmailField()
  @IsEmail({}, { message: 'Use a valid email' })
  to: string;
}

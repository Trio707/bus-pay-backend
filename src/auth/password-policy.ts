import { randomInt } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';

const WEAK_MESSAGE =
  'Password is too weak. Use at least 12 characters including uppercase, lowercase, number, and special character.';

const COMMON = new Set([
  'password123!',
  'changeme123!',
  'welcome123!',
  'qwerty12345!',
  'admin12345!',
]);

export function assertStrongPassword(
  password: string,
  identity: { phone?: string | null; nida?: string | null; username?: string | null } = {},
) {
  if (
    password.length < 12 ||
    !/[A-Z]/.test(password) ||
    !/[a-z]/.test(password) ||
    !/\d/.test(password) ||
    !/[^A-Za-z0-9]/.test(password)
  ) {
    throw new BadRequestException(WEAK_MESSAGE);
  }
  if (COMMON.has(password.toLowerCase())) {
    throw new BadRequestException(WEAK_MESSAGE);
  }
  const folded = password.toLowerCase();
  const phone = (identity.phone ?? '').replace(/\D/g, '');
  const national = phone.startsWith('255') ? phone.slice(3) : phone;
  if (national.length >= 9 && folded.includes(national)) {
    throw new BadRequestException(
      'Password must not be based on your phone, NIDA, or username.',
    );
  }
  const nida = (identity.nida ?? '').replace(/\D/g, '');
  if (nida.length >= 8) {
    for (let index = 0; index <= nida.length - 8; index += 1) {
      if (folded.includes(nida.slice(index, index + 8))) {
        throw new BadRequestException(
          'Password must not be based on your phone, NIDA, or username.',
        );
      }
    }
  }
  const username = (identity.username ?? '').trim().toLowerCase();
  if (username.length >= 4 && folded.includes(username)) {
    throw new BadRequestException(
      'Password must not be based on your phone, NIDA, or username.',
    );
  }
}

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const SPECIAL = '!@#$%^&*-_';

export function generateTemporaryPassword(length = 16): string {
  const chars = [
    UPPER[randomInt(UPPER.length)],
    LOWER[randomInt(LOWER.length)],
    DIGITS[randomInt(DIGITS.length)],
    SPECIAL[randomInt(SPECIAL.length)],
  ];
  const alphabet = UPPER + LOWER + DIGITS + SPECIAL;
  while (chars.length < length) {
    chars.push(alphabet[randomInt(alphabet.length)]);
  }
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const swap = randomInt(index + 1);
    const current = chars[index];
    chars[index] = chars[swap];
    chars[swap] = current;
  }
  return chars.join('');
}

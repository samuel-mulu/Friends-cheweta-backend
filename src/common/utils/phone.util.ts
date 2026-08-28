import { BadRequestException } from '@nestjs/common';

export function normalizeEthiopianPhone(input: string): string {
  const value = input.replace(/[\s()+-]/g, '');

  if (/^0[79]\d{8}$/.test(value)) return `251${value.slice(1)}`;
  if (/^[79]\d{8}$/.test(value)) return `251${value}`;
  if (/^251[79]\d{8}$/.test(value)) return value;

  throw new BadRequestException({
    code: 'INVALID_PHONE_NUMBER',
    message: 'Use a valid Ethiopian mobile number.',
  });
}

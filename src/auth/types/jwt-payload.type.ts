import { UserRole } from '../../generated/prisma/enums';

export type AccessTokenPayload = {
  sub: string;
  role: UserRole;
};

export type RefreshTokenPayload = {
  sub: string;
  sid: string;
  type: 'refresh';
};

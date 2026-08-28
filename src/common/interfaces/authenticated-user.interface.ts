import { UserRole, UserStatus } from '../../generated/prisma/enums';

export interface AuthenticatedUser {
  id: string;
  fullName: string;
  phoneNumber: string;
  role: UserRole;
  status: UserStatus;
}

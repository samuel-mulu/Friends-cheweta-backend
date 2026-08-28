import { IsEnum } from 'class-validator';
import { UserStatus } from '../../generated/prisma/enums';

export class UpdateUserStatusDto {
  @IsEnum(UserStatus)
  status!: UserStatus;
}

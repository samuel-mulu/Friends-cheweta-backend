import { IsString, Length, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @IsString()
  @Length(2, 80)
  fullName!: string;

  @IsString()
  @MaxLength(24)
  phoneNumber!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;

  @IsString()
  @MaxLength(120)
  deviceName?: string;
}

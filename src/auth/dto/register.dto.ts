import { IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';

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
  @Matches(/^\d{4}$/, {
    message: 'Enter the four-digit SMS code. Update the app if you cannot enter a code.',
  })
  otp!: string;

  @IsString()
  @MaxLength(120)
  deviceName?: string;
}

import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RejectPaymentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

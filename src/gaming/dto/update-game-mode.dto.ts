import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export class UpdateGameModeDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @Matches(/^\d+$/, { message: 'stakeAmountMinor must be a non-negative integer string.' })
  stakeAmountMinor?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  platformFeeBps?: number;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(300)
  turnDurationSeconds?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

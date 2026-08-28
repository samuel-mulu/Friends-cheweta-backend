import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export class CreateGameModeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  gameCode!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsInt()
  @Min(2)
  @Max(4)
  playerCount!: number;

  @Matches(/^\d+$/, { message: 'stakeAmountMinor must be a non-negative integer string.' })
  stakeAmountMinor!: string;

  @IsInt()
  @Min(0)
  @Max(10000)
  platformFeeBps!: number;

  @IsInt()
  @Min(5)
  @Max(300)
  turnDurationSeconds!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  rulesVersion!: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

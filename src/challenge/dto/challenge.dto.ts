import { IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';

export class ChallengeCreateDto {
  @IsUUID()
  commandId!: string;

  @IsString()
  opponentUserId!: string;

  /** "First to N home" (1-4). Default 4 = classic. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4)
  tokensToWin?: number;
}

export class ChallengeCommandDto {
  @IsUUID()
  commandId!: string;

  @IsUUID()
  challengeId!: string;
}

export class ChallengeRematchDto {
  @IsUUID()
  commandId!: string;

  @IsUUID()
  matchId!: string;
}

export class InviteCreateDto {
  @IsUUID()
  commandId!: string;

  @IsString()
  gameModeId!: string;

  /** "First to N home" (1-4). Default 4 = classic. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4)
  tokensToWin?: number;
}

export class InviteJoinDto {
  @IsUUID()
  commandId!: string;

  @IsString()
  @Length(4, 20)
  code!: string;
}

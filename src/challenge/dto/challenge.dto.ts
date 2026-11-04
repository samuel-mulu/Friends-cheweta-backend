import { IsString, IsUUID, Length } from 'class-validator';

export class ChallengeCreateDto {
  @IsUUID()
  commandId!: string;

  @IsString()
  opponentUserId!: string;
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
}

export class InviteJoinDto {
  @IsUUID()
  commandId!: string;

  @IsString()
  @Length(4, 20)
  code!: string;
}

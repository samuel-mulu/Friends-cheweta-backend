import { IsString, IsUUID } from 'class-validator';

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

import { IsString, IsUUID, MaxLength } from 'class-validator';

export class LobbyChatSendDto {
  @IsUUID()
  commandId!: string;

  @IsString()
  @MaxLength(200)
  text!: string;
}

export class MatchChatSendDto {
  @IsUUID()
  commandId!: string;

  @IsUUID()
  matchId!: string;

  @IsString()
  @MaxLength(200)
  text!: string;
}

export class MatchChatHistoryDto {
  @IsUUID()
  matchId!: string;
}

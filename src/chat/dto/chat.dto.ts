import { IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

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

export class DirectChatSendDto {
  @IsUUID()
  commandId!: string;

  @IsUUID()
  toUserId!: string;

  @IsString()
  @MaxLength(200)
  text!: string;
}

export class DirectChatPeerDto {
  @IsUUID()
  peerId!: string;

  @IsOptional()
  @IsISO8601()
  before?: string;
}

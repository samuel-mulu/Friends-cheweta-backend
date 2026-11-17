import { IsOptional, IsString, IsUUID, Matches } from 'class-validator';

export class LobbyJoinDto {
  @IsUUID()
  commandId!: string;

  @IsString()
  gameModeId!: string;
}

/** Open a game's lobby (every stake), sitting at `gameModeId` or the default stake. */
export class LobbyJoinGameDto {
  @IsUUID()
  commandId!: string;

  @Matches(/^[A-Z_]{2,20}$/)
  gameCode!: string;

  @IsOptional()
  @IsString()
  gameModeId?: string;
}

export class LobbyCommandDto {
  @IsUUID()
  commandId!: string;
}

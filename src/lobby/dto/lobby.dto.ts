import { IsInt, IsOptional, IsString, IsUUID, Matches, Max, Min } from 'class-validator';

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

  /** Sit at a custom stake of this amount (minor units) instead. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  customStakeMinor?: number;
}

export class LobbyCommandDto {
  @IsUUID()
  commandId!: string;
}

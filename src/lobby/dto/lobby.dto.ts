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

  /**
   * With `customStakeMinor`: the rules of the custom stake (e.g. Dama ታንከኛ
   * `DAMA_ET_V1` or እግረኛ `DAMA_ET_FORWARD_V1`). Default: the smallest stake's.
   */
  @IsOptional()
  @Matches(/^[A-Z0-9_]{2,40}$/)
  rulesVersion?: string;
}

export class LobbyCommandDto {
  @IsUUID()
  commandId!: string;
}

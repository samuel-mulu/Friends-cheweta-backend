import { IsString, IsUUID } from 'class-validator';

export class LobbyJoinDto {
  @IsUUID()
  commandId!: string;

  @IsString()
  gameModeId!: string;
}

export class LobbyCommandDto {
  @IsUUID()
  commandId!: string;
}

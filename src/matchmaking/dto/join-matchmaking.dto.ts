import { IsString, MinLength } from 'class-validator';

export class JoinMatchmakingDto {
  @IsString()
  @MinLength(1)
  gameModeId!: string;
}

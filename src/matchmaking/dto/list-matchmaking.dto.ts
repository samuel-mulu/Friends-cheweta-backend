import { IsString, MinLength } from 'class-validator';

export class ListMatchmakingDto {
  @IsString()
  @MinLength(1)
  gameModeId!: string;
}

import { IsOptional, IsString, MinLength } from 'class-validator';

export class JoinMatchmakingDto {
  @IsString()
  @MinLength(1)
  gameModeId!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  ticketId?: string;
}

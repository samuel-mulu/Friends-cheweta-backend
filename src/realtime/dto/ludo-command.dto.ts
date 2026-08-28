import { IsInt, IsString, Min, MinLength } from 'class-validator';

export class MatchJoinDto {
  @IsString()
  @MinLength(1)
  matchId!: string;
}

export class LudoCommandDto extends MatchJoinDto {
  @IsString()
  @MinLength(8)
  commandId!: string;

  @IsInt()
  @Min(0)
  expectedVersion!: number;
}

export class LudoMoveCommandDto extends LudoCommandDto {
  @IsString()
  @MinLength(1)
  tokenId!: string;
}

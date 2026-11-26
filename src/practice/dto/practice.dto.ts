import { IsIn, IsInt, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';
import {
  PRACTICE_GAMES,
  PRACTICE_LEVELS,
  PracticeGame,
  PracticeLevel,
} from '../practice.constants';

export class PracticeStartDto {
  @IsUUID()
  commandId!: string;

  @IsIn(PRACTICE_LEVELS)
  level!: PracticeLevel;

  /** "First to N home" (1-4). Default 4 = classic. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4)
  tokensToWin?: number;

  /** Which game to practise. Default LUDO. */
  @IsOptional()
  @IsIn(PRACTICE_GAMES)
  game?: PracticeGame;

  /**
   * The game type (rules version), e.g. Dama `DAMA_ET_FORWARD_V1` or Ludo
   * `LUDO_NO_CAPTURE_V1`. One of another game is ignored (default rules).
   */
  @IsOptional()
  @Matches(/^[A-Z0-9_]{2,40}$/)
  rulesVersion?: string;
}

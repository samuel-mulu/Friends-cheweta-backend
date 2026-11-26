import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { DAMA_RULES_VERSIONS, DamaRulesVersion } from '../../games/dama/domain';
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

  /** Dama only: ታንከኛ `DAMA_ET_V1` (default) or እግረኛ `DAMA_ET_FORWARD_V1`. */
  @IsOptional()
  @IsIn(DAMA_RULES_VERSIONS)
  rulesVersion?: DamaRulesVersion;
}

import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { PRACTICE_LEVELS, PracticeLevel } from '../practice.constants';

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
}

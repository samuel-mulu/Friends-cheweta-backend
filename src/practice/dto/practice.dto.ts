import { IsIn, IsUUID } from 'class-validator';
import { PRACTICE_LEVELS, PracticeLevel } from '../practice.constants';

export class PracticeStartDto {
  @IsUUID()
  commandId!: string;

  @IsIn(PRACTICE_LEVELS)
  level!: PracticeLevel;
}

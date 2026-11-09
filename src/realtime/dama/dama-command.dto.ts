import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, Max, Min } from 'class-validator';
import { LudoCommandDto } from '../dto/ludo-command.dto';

/** `{ matchId, commandId, expectedVersion }`: the same envelope as every game command. */
export class DamaCommandDto extends LudoCommandDto {}

export class DamaMoveDto extends DamaCommandDto {
  /** Start square then each landing square (0-63). At most 12 captures + start. */
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(13)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(63, { each: true })
  path!: number[];
}

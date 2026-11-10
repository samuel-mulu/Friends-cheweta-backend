import { Injectable } from '@nestjs/common';
import { GameEntryService } from '../../game-entry/game-entry.service';
import { DamaMove } from '../../games/dama/domain';
import { DamaMatchRuntimeState, DamaRuntimeCommand, DamaRuntimeEvent, currentLegalMoves } from '../../games/dama/runtime';
import { MatchHistoryService } from '../../match-history/match-history.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { SettlementService } from '../../settlement/settlement.service';
import { TurnGameExecution, TurnGameRuntime } from '../turn-game/turn-game-runtime';
import { DamaRuntimeRepository } from './dama-runtime.repository';
import { DAMA_GAME } from './dama.definition';

export { DAMA_GAME_CODE } from './dama.definition';

export type DamaExecution = TurnGameExecution<DamaMatchRuntimeState, DamaRuntimeEvent>;

/** Authoritative Dama matches (shared turn-game runtime). */
@Injectable()
export class DamaRuntimeService extends TurnGameRuntime<DamaMatchRuntimeState, DamaRuntimeCommand, DamaRuntimeEvent> {
  constructor(
    prisma: PrismaService,
    redis: RedisService,
    store: DamaRuntimeRepository,
    gameEntry: GameEntryService,
    settlement: SettlementService,
    history: MatchHistoryService,
  ) {
    super(DAMA_GAME, prisma, redis, store, gameEntry, settlement, history);
  }

  legalMoves(state: DamaMatchRuntimeState): DamaMove[] {
    return currentLegalMoves(state);
  }
}

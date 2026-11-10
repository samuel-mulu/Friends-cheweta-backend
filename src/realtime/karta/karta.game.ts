import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomInt } from 'node:crypto';
import { AppEnv } from '../../config/env';
import { GameEntryService } from '../../game-entry/game-entry.service';
import {
  KARTA_RANKS,
  KartaMatchRuntimeState,
  KartaRuntimeCommand,
  KartaRuntimeEvent,
  createKartaMatch,
  executeKartaCommand,
  isKartaRulesVersion,
  publicKartaState,
} from '../../games/karta';
import { MatchHistoryService } from '../../match-history/match-history.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { SettlementService } from '../../settlement/settlement.service';
import { RealtimePublisherService } from '../realtime-publisher.service';
import { RuntimeStore } from '../runtime-store';
import { TurnGameDefinition } from '../turn-game/turn-game.definition';
import { TurnGameRuntime } from '../turn-game/turn-game-runtime';
import { TurnGameTimer } from '../turn-game/turn-game-timer';

export const KARTA_GAME_CODE = 'KARTA';

/** 32 random bytes per round: the secret that orders the deck. */
const cryptoSeed = () => randomBytes(32).toString('hex');

/** Karta Lat Lat on the shared turn-game runtime. */
export const KARTA_GAME: TurnGameDefinition<KartaMatchRuntimeState, KartaRuntimeCommand, KartaRuntimeEvent> = {
  code: KARTA_GAME_CODE,
  key: 'karta',
  eventNames: {
    ROUND_STARTED: 'karta:round_started',
    RANK_CALLED: 'karta:rank_called',
    CARD_FLIPPED: 'karta:card_flipped',
    ROUND_WON: 'karta:round_won',
    PLAYER_RESIGNED: 'karta:player_resigned',
    MATCH_FINISHED: 'match:finished',
  },
  defaultTurnSeconds: 15,
  isRulesVersion: isKartaRulesVersion,
  // Who starts (deals) round 1 is drawn fairly.
  create: (matchId, [a, b]) => createKartaMatch(matchId, [a, b], randomInt(2) === 0 ? a : b, cryptoSeed),
  execute: (state, command) => executeKartaCommand(state, command, cryptoSeed),
  isFinished: (state) => state.game.phase === 'FINISHED',
  // Time ran out: the chooser calls a random rank, or the starter turns the next card.
  autoCommand: (state) =>
    state.game.roundPhase === 'CALLING' ? { type: 'CALL', rank: KARTA_RANKS[randomInt(KARTA_RANKS.length)] } : { type: 'FLIP' },
  resignCommand: () => ({ type: 'RESIGN' }),
  // Never send the seed of a round in play.
  publicState: publicKartaState,
};

@Injectable()
export class KartaRuntimeRepository extends RuntimeStore<KartaMatchRuntimeState, KartaRuntimeEvent> {
  constructor(redis: RedisService, config: ConfigService<AppEnv, true>) {
    super(
      redis,
      'karta',
      config.get('REDIS_RUNTIME_TTL_SECONDS', { infer: true }),
      config.get('REDIS_COMMAND_TTL_SECONDS', { infer: true }),
    );
  }
}

@Injectable()
export class KartaRuntimeService extends TurnGameRuntime<KartaMatchRuntimeState, KartaRuntimeCommand, KartaRuntimeEvent> {
  constructor(
    prisma: PrismaService,
    redis: RedisService,
    store: KartaRuntimeRepository,
    gameEntry: GameEntryService,
    settlement: SettlementService,
    history: MatchHistoryService,
  ) {
    super(KARTA_GAME, prisma, redis, store, gameEntry, settlement, history);
  }
}

@Injectable()
export class KartaTurnTimerService extends TurnGameTimer<KartaMatchRuntimeState, KartaRuntimeCommand, KartaRuntimeEvent> {
  constructor(
    runtime: KartaRuntimeService,
    redis: RedisService,
    prisma: PrismaService,
    publisher: RealtimePublisherService,
    config: ConfigService<AppEnv, true>,
  ) {
    super(runtime, redis, prisma, publisher, config.get('LUDO_MAX_CONSECUTIVE_TIMEOUTS', { infer: true }));
  }
}

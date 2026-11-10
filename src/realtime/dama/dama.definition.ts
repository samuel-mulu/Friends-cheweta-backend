import { randomInt } from 'node:crypto';
import { DamaPhase, isDamaRulesVersion } from '../../games/dama/domain';
import {
  DamaMatchRuntimeState,
  DamaRuntimeCommand,
  DamaRuntimeEvent,
  colorOfPlayer,
  createDamaMatch,
  currentLegalMoves,
  executeDamaCommand,
} from '../../games/dama/runtime';
import { MinimaxDamaBot } from '../../games/dama/simulation';
import { DAMA_EVENT_NAMES } from '../realtime-publisher.service';
import { TurnGameDefinition } from '../turn-game/turn-game.definition';

export const DAMA_GAME_CODE = 'DAMA';

/** Ethiopian Dama on the shared turn-game runtime. */
export const DAMA_GAME: TurnGameDefinition<DamaMatchRuntimeState, DamaRuntimeCommand, DamaRuntimeEvent> = {
  code: DAMA_GAME_CODE,
  key: 'dama',
  eventNames: DAMA_EVENT_NAMES,
  defaultTurnSeconds: 40,
  isRulesVersion: isDamaRulesVersion,
  // Colours are drawn fairly: whoever gets Light moves first.
  create: (matchId, [a, b]) => {
    const light = randomInt(2);
    return createDamaMatch(matchId, light === 0 ? a : b, light === 0 ? b : a);
  },
  execute: executeDamaCommand,
  isFinished: (state) => state.game.phase === DamaPhase.FINISHED,
  // A timed-out player gets a sensible move (one-ply search), not a random one.
  autoCommand: (state, playerId) => ({
    type: 'MOVE',
    path: new MinimaxDamaBot(1, state.game.version + 1).choose(state.game, colorOfPlayer(state.game, playerId), currentLegalMoves(state))
      .path,
  }),
  resignCommand: () => ({ type: 'RESIGN' }),
  publicState: (state) => state,
  playerInfo: (state, userId) => ({ color: state.game.players.find((p) => p.userId === userId)?.color ?? null }),
};

import { CryptoDiceProvider } from '../../games/ludo/dice';
import {
  LudoMatchPhase,
  LudoRulesVersion,
  LudoTurnPhase,
  boardOf,
  isLudoRulesVersion,
  isSafeGlobalSquare,
} from '../../games/ludo/domain';
import { LudoEngine, LudoMovePreview } from '../../games/ludo/engine';
import {
  LudoMatchRuntime,
  LudoMatchRuntimeState,
  LudoRuntimeCommand,
  LudoRuntimeEvent,
} from '../../games/ludo/runtime';
import { LUDO_EVENT_NAMES } from '../realtime-publisher.service';
import { chooseTimeoutMove } from '../timeout/timeout-move-chooser';
import { TurnGameDefinition } from '../turn-game/turn-game.definition';

export const LUDO_GAME_CODE = 'LUDO';

const engine = new LudoEngine();

/** Landing preview for whoever must move now (derived from state, so never stale). */
export function previewLudoMoves(state: LudoMatchRuntimeState): LudoMovePreview[] {
  const game = state.game;
  if (
    game.turnPhase !== LudoTurnPhase.WAITING_FOR_MOVE ||
    !game.currentPlayerId ||
    game.diceValue === null
  )
    return [];
  return engine.getLegalMoves(game, game.currentPlayerId, game.diceValue).map((move) => ({
    tokenId: move.tokenId,
    toProgress: move.toProgress,
    captures: [...move.capturedTokenIds],
    safe: move.destinationGlobalSquare !== null && isSafeGlobalSquare(move.destinationGlobalSquare),
  }));
}

/** Ludo (2–4 players, starting roll, "first to N home") on the shared turn-game runtime. */
export const LUDO_GAME: TurnGameDefinition<
  LudoMatchRuntimeState,
  LudoRuntimeCommand,
  LudoRuntimeEvent
> = {
  code: LUDO_GAME_CODE,
  key: 'ludo',
  eventNames: LUDO_EVENT_NAMES,
  defaultTurnSeconds: 30,
  minPlayers: 2,
  maxPlayers: 4,
  isRulesVersion: isLudoRulesVersion,
  create: (matchId, playerIds, rulesVersion, options) =>
    new LudoMatchRuntime(
      matchId,
      playerIds,
      new CryptoDiceProvider(),
      undefined,
      rulesVersion as LudoRulesVersion,
      {
        tokensToWin: options.tokensToWin,
      },
    ).getState(),
  execute: (state, command) => {
    const result = LudoMatchRuntime.restore(state, new CryptoDiceProvider()).execute(command);
    return { state: result.state, events: result.events };
  },
  isFinished: (state) => state.game.phase === LudoMatchPhase.FINISHED,
  isPreGame: (state) => state.game.phase === LudoMatchPhase.PRE_GAME,
  // Starting roll: everyone who has not rolled yet; otherwise the player to move.
  actingPlayers: (state) =>
    state.game.phase === LudoMatchPhase.PRE_GAME
      ? state.startingRoll.candidatePlayerIds.filter(
          (id) => state.startingRoll.rolls[id] === undefined,
        )
      : state.game.currentPlayerId
        ? [state.game.currentPlayerId]
        : [],
  requiresAllJoined: (command) => command.type === 'ROLL_FOR_START',
  autoCommand: (state, playerId) => {
    const game = state.game;
    if (game.phase === LudoMatchPhase.PRE_GAME) return { type: 'ROLL_FOR_START' };
    if (game.turnPhase === LudoTurnPhase.WAITING_FOR_ROLL) return { type: 'ROLL_DICE' };
    if (game.turnPhase === LudoTurnPhase.WAITING_FOR_MOVE) {
      const tokenId = chooseTimeoutMove(game, playerId);
      return tokenId ? { type: 'MOVE_TOKEN', tokenId } : null;
    }
    return null;
  },
  resignCommand: () => ({ type: 'RESIGN' }),
  canResign: (state, userId) =>
    state.game.phase !== LudoMatchPhase.FINISHED &&
    !state.resignedPlayerIds.includes(userId) &&
    !state.game.winnerOrder.includes(userId),
  turnPhase: (state) => state.game.turnPhase,
  publicState: (state) => state,
  playerInfo: (state, userId) => ({
    color: state.game.players.find((player) => player.userId === userId)?.color ?? null,
  }),
  snapshotExtras: (state) => ({ legalMoves: previewLudoMoves(state), board: boardOf(state.game) }),
};

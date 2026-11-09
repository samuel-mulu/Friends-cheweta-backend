import { DamaFinishReason, DamaPhase, DamaResult } from '../domain';
import { DamaMatchRuntimeState, colorOfPlayer, createDamaMatch, currentLegalMoves, executeDamaCommand } from '../runtime';
import { DamaBot } from './dama.bots';

export type DamaSimulationResult = {
  state: DamaMatchRuntimeState;
  plies: number;
  result: DamaResult;
  reason: DamaFinishReason;
  winnerOrder: string[];
};

/**
 * Plays a whole match through the real runtime (validation + invariants on
 * every ply). Throws if the game does not end within `maxPlies`.
 */
export function simulateDamaMatch(input: {
  matchId: string;
  light: { userId: string; bot: DamaBot };
  dark: { userId: string; bot: DamaBot };
  maxPlies?: number;
}): DamaSimulationResult {
  const maxPlies = input.maxPlies ?? 2000;
  let state = createDamaMatch(input.matchId, input.light.userId, input.dark.userId);
  const bots: Record<string, DamaBot> = {
    [input.light.userId]: input.light.bot,
    [input.dark.userId]: input.dark.bot,
  };

  while (state.game.phase === DamaPhase.PLAYING) {
    if (state.game.plyCount >= maxPlies) throw new Error('DAMA_SIMULATION_PLY_LIMIT');
    const playerId = state.game.currentPlayerId!;
    const move = bots[playerId].choose(state.game, colorOfPlayer(state.game, playerId), currentLegalMoves(state));
    state = executeDamaCommand(state, {
      type: 'MOVE',
      commandId: `${input.matchId}:${state.game.version}`,
      playerId,
      expectedVersion: state.game.version,
      path: move.path,
    }).state;
  }

  return {
    state,
    plies: state.game.plyCount,
    result: state.game.result!,
    reason: state.game.finishReason!,
    winnerOrder: state.game.winnerOrder,
  };
}

import {
  LUDO_BASE_PROGRESS,
  assertValidLudoState,
  isSafeGlobalSquare,
} from '../domain';
import { LudoGameState, LudoTokenState } from '../domain';
import { LudoMoveResolution } from './ludo.engine.types';
import { getLegalMoves } from './ludo.legal-moves';
import { getTokenById } from './ludo.position';

function cloneState(state: LudoGameState): LudoGameState {
  return {
    ...state,
    players: state.players.map((player) => ({
      ...player,
      tokens: player.tokens.map((token) => ({ ...token })),
    })),
    legalTokenIds: [...state.legalTokenIds],
    winnerOrder: [...state.winnerOrder],
  };
}

export function applyLudoMove(
  state: LudoGameState,
  playerId: string,
  tokenId: string,
  diceValue: number,
): { state: LudoGameState; resolution: LudoMoveResolution } {
  assertValidLudoState(state);

  const legalMove = getLegalMoves(state, playerId, diceValue).find((move) => move.tokenId === tokenId);
  if (!legalMove) throw new Error('ILLEGAL_LUDO_MOVE');

  const beforeToken = getTokenById(state, tokenId);
  if (!beforeToken || beforeToken.ownerId !== playerId) throw new Error('ILLEGAL_LUDO_MOVE');

  const next = cloneState(state);
  const movingToken = getTokenById(next, tokenId);
  if (!movingToken) throw new Error('Token disappeared while applying move.');

  movingToken.progress = legalMove.toProgress;
  movingToken.state = legalMove.toState;

  const capturedTokenIds: string[] = [];
  if (
    legalMove.destinationGlobalSquare !== null &&
    !isSafeGlobalSquare(legalMove.destinationGlobalSquare)
  ) {
    const captures = new Set(legalMove.capturedTokenIds);
    for (const opponent of next.players) {
      if (opponent.userId === playerId) continue;
      for (const token of opponent.tokens) {
        if (!captures.has(token.id)) continue;
        token.progress = LUDO_BASE_PROGRESS;
        token.state = LudoTokenState.BASE;
        capturedTokenIds.push(token.id);
      }
    }
  }

  next.version += 1;
  next.diceValue = diceValue;
  next.legalTokenIds = [];
  assertValidLudoState(next);

  return {
    state: next,
    resolution: {
      stateVersionBefore: state.version,
      stateVersionAfter: next.version,
      playerId,
      diceValue,
      move: { ...legalMove, capturedTokenIds },
      tokenBefore: { ...beforeToken },
      tokenAfter: { ...movingToken },
      capturedTokenIds,
    },
  };
}

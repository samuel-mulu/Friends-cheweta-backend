import { LudoGameState, isSafeGlobalSquare } from '../domain';
import { LudoLegalMove, LudoMovePreview, LudoMoveResolution } from './ludo.engine.types';
import { getLegalMoves, getLegalTokenIds } from './ludo.legal-moves';
import { applyLudoMove } from './ludo.move-resolver';

/**
 * Pure Ludo rules facade. It has no NestJS, Prisma, Redis, Socket.IO, clock,
 * or random-number dependency. B9 will orchestrate turn state around it.
 */
export class LudoEngine {
  getLegalMoves(state: LudoGameState, playerId: string, diceValue: number): LudoLegalMove[] {
    return getLegalMoves(state, playerId, diceValue);
  }

  /** Landing preview for the legal moves (derived; nothing is stored). */
  previewMoves(state: LudoGameState, playerId: string, diceValue: number): LudoMovePreview[] {
    return getLegalMoves(state, playerId, diceValue).map((move) => ({
      tokenId: move.tokenId,
      toProgress: move.toProgress,
      captures: [...move.capturedTokenIds],
      safe: move.destinationGlobalSquare !== null && isSafeGlobalSquare(move.destinationGlobalSquare),
    }));
  }

  getLegalTokenIds(state: LudoGameState, playerId: string, diceValue: number): string[] {
    return getLegalTokenIds(state, playerId, diceValue);
  }

  move(
    state: LudoGameState,
    playerId: string,
    tokenId: string,
    diceValue: number,
  ): { state: LudoGameState; resolution: LudoMoveResolution } {
    return applyLudoMove(state, playerId, tokenId, diceValue);
  }
}

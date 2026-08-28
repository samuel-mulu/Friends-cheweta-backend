import { LudoGameState } from '../../domain';
import { LudoEngine, LudoLegalMove } from '../../engine';

const engine = new LudoEngine();

function tokenThreatened(state: LudoGameState, ownerId: string, tokenId: string): boolean {
  for (const opponent of state.players) {
    if (opponent.userId === ownerId) continue;
    for (let die = 1; die <= 6; die += 1) {
      const canCapture = engine
        .getLegalMoves(state, opponent.userId, die)
        .some((move) => move.capturedTokenIds.includes(tokenId));
      if (canCapture) return true;
    }
  }
  return false;
}

export function defensiveMoves(
  state: LudoGameState,
  playerId: string,
  diceValue: number,
  legalMoves: readonly LudoLegalMove[],
): LudoLegalMove[] {
  const result: LudoLegalMove[] = [];
  for (const move of legalMoves) {
    if (!tokenThreatened(state, playerId, move.tokenId)) continue;
    const moved = engine.move(state, playerId, move.tokenId, diceValue).state;
    if (!tokenThreatened(moved, playerId, move.tokenId)) result.push(move);
  }
  return result;
}

export function aggressiveMoves(legalMoves: readonly LudoLegalMove[]): LudoLegalMove[] {
  return legalMoves.filter((move) => move.capturedTokenIds.length > 0);
}

export function fastestMoves(legalMoves: readonly LudoLegalMove[]): LudoLegalMove[] {
  if (legalMoves.length === 0) return [];
  const max = Math.max(...legalMoves.map((move) => move.toProgress));
  return legalMoves.filter((move) => move.toProgress === max);
}

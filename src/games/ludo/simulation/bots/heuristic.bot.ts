import {
  LudoGameState,
  LudoTokenState,
  isSafeGlobalSquare,
  toGlobalTrackIndex,
} from '../../domain';
import { LudoEngine, LudoLegalMove, LudoMoveKind } from '../../engine';
import { BotRandom, LudoBot } from './bot.types';

const engine = new LudoEngine();
const LAST_TRACK_PROGRESS = 51;

/**
 * Scores every legal move like an experienced player: take captures, get
 * tokens home, leave the yard, prefer safe squares, escape danger and avoid
 * landing where an opponent can hit you next turn. Used for "Hard" practice.
 */
export class HeuristicBot implements LudoBot {
  readonly name = 'HEURISTIC';
  private readonly random: BotRandom;

  constructor(seed = 11) {
    this.random = new BotRandom(seed);
  }

  chooseMove(
    state: LudoGameState,
    playerId: string,
    diceValue: number,
    legalMoves: readonly LudoLegalMove[],
  ): LudoLegalMove {
    if (legalMoves.length === 0) throw new Error('BOT_NO_LEGAL_MOVE');
    let best: LudoLegalMove[] = [];
    let bestScore = -Infinity;
    for (const move of legalMoves) {
      const score = this.score(state, playerId, diceValue, move);
      if (score > bestScore + 1e-9) {
        bestScore = score;
        best = [move];
      } else if (Math.abs(score - bestScore) <= 1e-9) {
        best.push(move);
      }
    }
    return best[this.random.nextInt(best.length)];
  }

  private score(
    state: LudoGameState,
    playerId: string,
    diceValue: number,
    move: LudoLegalMove,
  ): number {
    let score = 0;
    score += move.capturedTokenIds.length * 120;
    if (move.toProgress >= 57) score += 90;
    else if (move.toProgress >= 52) score += 35; // home lane cannot be attacked
    if (move.kind === LudoMoveKind.DEPLOY) score += 60;
    if (move.destinationGlobalSquare !== null && isSafeGlobalSquare(move.destinationGlobalSquare))
      score += 25;

    const before = threatened(state, playerId, move.tokenId);
    const after = threatened(
      engine.move(state, playerId, move.tokenId, diceValue).state,
      playerId,
      move.tokenId,
    );
    if (before && !after) score += 50;
    if (after) score -= 70;

    score += (move.toProgress - Math.max(move.fromProgress, 0)) * 0.8;
    return score;
  }
}

/** Can any opponent token reach this token's square with one die (1–6)? */
function threatened(state: LudoGameState, ownerId: string, tokenId: string): boolean {
  const owner = state.players.find((player) => player.userId === ownerId);
  const token = owner?.tokens.find((t) => t.id === tokenId);
  if (
    !owner ||
    !token ||
    token.state !== LudoTokenState.ACTIVE ||
    token.progress < 0 ||
    token.progress > LAST_TRACK_PROGRESS
  ) {
    return false;
  }
  const target = toGlobalTrackIndex(owner.color, token.progress);
  if (isSafeGlobalSquare(target)) return false;

  for (const opponent of state.players) {
    if (opponent.userId === ownerId) continue;
    for (const attacker of opponent.tokens) {
      if (
        attacker.state !== LudoTokenState.ACTIVE ||
        attacker.progress < 0 ||
        attacker.progress > LAST_TRACK_PROGRESS
      )
        continue;
      const from = toGlobalTrackIndex(opponent.color, attacker.progress);
      const distance = (target - from + 52) % 52;
      if (distance >= 1 && distance <= 6 && attacker.progress + distance <= LAST_TRACK_PROGRESS)
        return true;
    }
  }
  return false;
}

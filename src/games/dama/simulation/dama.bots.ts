import { DamaBoard, DamaColor, DamaGameState, DamaMove, colorOf, isKing, opponentOf, rowOf, colOf } from '../domain';
import { applyMove, legalMoves } from '../engine';

export interface DamaBot {
  readonly name: string;
  /** `moves` is never empty. */
  choose(game: DamaGameState, color: DamaColor, moves: DamaMove[]): DamaMove;
}

/** Small seeded PRNG (mulberry32) so bot games replay exactly. */
export function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class RandomDamaBot implements DamaBot {
  readonly name = 'random';
  private readonly random: () => number;
  constructor(seed = 1) {
    this.random = seededRandom(seed);
  }
  choose(_game: DamaGameState, _color: DamaColor, moves: DamaMove[]): DamaMove {
    return moves[Math.floor(this.random() * moves.length)];
  }
}

const MAN = 100;
const KING = 320; // flying kings dominate the endgame
const WIN = 100_000;

/** Material + men advancement + a little centre control, from `color`'s side. */
export function evaluateBoard(board: DamaBoard, color: DamaColor): number {
  let score = 0;
  for (let square = 0; square < 64; square += 1) {
    const cell = board[square];
    const owner = colorOf(cell);
    if (!owner) continue;
    let value: number;
    if (isKing(cell)) value = KING;
    else value = MAN + 4 * (owner === DamaColor.LIGHT ? rowOf(square) : 7 - rowOf(square));
    const col = colOf(square);
    const row = rowOf(square);
    if (col >= 2 && col <= 5 && row >= 2 && row <= 5) value += 3;
    score += owner === color ? value : -value;
  }
  return score;
}

/**
 * Negamax with alpha-beta pruning. Ties between equally good moves are broken
 * by the seeded PRNG so the bot doesn't play the same game every time.
 */
export class MinimaxDamaBot implements DamaBot {
  readonly name: string;
  private readonly random: () => number;
  constructor(
    private readonly depth: number,
    seed = 1,
  ) {
    this.name = `minimax-${depth}`;
    this.random = seededRandom(seed);
  }

  choose(game: DamaGameState, color: DamaColor, moves: DamaMove[]): DamaMove {
    if (moves.length === 1) return moves[0];
    let best = -Infinity;
    let choices: DamaMove[] = [];
    for (const move of moves) {
      const after = applyMove(game.board, move).board;
      const score = -this.search(after, opponentOf(color), this.depth - 1, -Infinity, -best + 1);
      if (score > best) {
        best = score;
        choices = [move];
      } else if (score === best) {
        choices.push(move);
      }
    }
    return choices[Math.floor(this.random() * choices.length)];
  }

  private search(board: DamaBoard, color: DamaColor, depth: number, alpha: number, beta: number): number {
    const moves = legalMoves(board, color);
    if (moves.length === 0) return -WIN - depth; // blocked or no pieces: lost (prefer faster wins)
    if (depth <= 0) return evaluateBoard(board, color);
    let best = -Infinity;
    for (const move of moves) {
      const score = -this.search(applyMove(board, move).board, opponentOf(color), depth - 1, -beta, -alpha);
      if (score > best) best = score;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }
}

export type DamaBotLevel = 'EASY' | 'NORMAL' | 'HARD';

/** Practice strength per level (ranked by `npm run bots:dama`). */
export function damaBotFor(level: DamaBotLevel, seed: number): DamaBot {
  switch (level) {
    case 'EASY':
      return new RandomDamaBot(seed);
    case 'NORMAL':
      return new MinimaxDamaBot(2, seed);
    case 'HARD':
      return new MinimaxDamaBot(4, seed);
  }
}

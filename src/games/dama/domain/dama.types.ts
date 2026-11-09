/**
 * Ethiopian Dama (ዳማ), rules version DAMA_ET_V1.
 *
 * Board: 8×8, play on the dark squares only. Squares are indexed 0..63 as
 * `row * 8 + col`; row 0 is Light's back rank, row 7 is Dark's. A square is
 * dark when `(row + col)` is even, so a1 (index 0) is dark.
 */
export const DAMA_ET_V1 = 'DAMA_ET_V1' as const;
export type DamaRulesVersion = typeof DAMA_ET_V1;

export function isDamaRulesVersion(value: string): value is DamaRulesVersion {
  return value === DAMA_ET_V1;
}

export enum DamaColor {
  LIGHT = 'LIGHT',
  DARK = 'DARK',
}

export enum DamaPhase {
  PLAYING = 'PLAYING',
  FINISHED = 'FINISHED',
}

/**
 * One character per square (64 chars):
 * `.` empty, `l` light man, `L` light king, `d` dark man, `D` dark king.
 * Compact, JSON-friendly and readable in tests.
 */
export type DamaBoard = string;

export const EMPTY = '.';
export type DamaCell = '.' | 'l' | 'L' | 'd' | 'D';

export type DamaPlayer = {
  userId: string;
  color: DamaColor;
};

/** `path[0]` is the starting square; the piece ends on the last square. */
export type DamaMove = {
  path: number[];
  /** Squares of the captured pieces, in capture order (empty for a quiet move). */
  captured: number[];
};

export type DamaResult = 'WIN' | 'DRAW';
export type DamaFinishReason = 'NO_PIECES' | 'NO_MOVES' | 'RESIGN' | 'DRAW_RULE';

export type DamaGameState = {
  matchId: string;
  rulesVersion: DamaRulesVersion;
  version: number;
  phase: DamaPhase;
  /** Light first (Light moves first). */
  players: DamaPlayer[];
  board: DamaBoard;
  currentPlayerId: string | null;
  /** Plies played in total. */
  plyCount: number;
  /** Plies since the last capture or man move (draw rule). */
  pliesSinceProgress: number;
  lastMove: DamaMove | null;
  /** Winner first; empty for a draw. */
  winnerOrder: string[];
  result: DamaResult | null;
  finishReason: DamaFinishReason | null;
};

/** Plies without a capture or a man moving that end the game in a draw (20 each). */
export const DAMA_DRAW_PLIES = 40;
export const DAMA_PIECES_PER_PLAYER = 12;

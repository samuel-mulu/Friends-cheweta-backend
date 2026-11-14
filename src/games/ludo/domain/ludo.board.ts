import { LudoBoardRules, LudoRulesVersion, rulesFor } from './ludo.rules';
import { LudoColor } from './ludo.types';

export const LUDO_BASE_PROGRESS = -1;

/** Global common-track start index for each color (the loop always has 52 cells). */
export const LUDO_START_INDEX: Record<LudoColor, number> = {
  [LudoColor.RED]: 0,
  [LudoColor.GREEN]: 13,
  [LudoColor.YELLOW]: 26,
  [LudoColor.BLUE]: 39,
};

/**
 * Friends Game Hub safe-square map: the four start squares and the star square
 * eight cells after each one. Board-independent (indexes the 52-cell loop).
 */
export const LUDO_SAFE_GLOBAL_SQUARES = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

/**
 * Resolved geometry for one rules version. All progress thresholds the engine
 * needs, derived once from the rules' `board`.
 */
export type LudoBoardSpec = LudoBoardRules & {
  /** Last shared-track progress a colour visits before its home column. */
  trackLast: number;
  homeStart: number;
  homeLast: number;
  finish: number;
};

export function resolveBoard(board: LudoBoardRules): LudoBoardSpec {
  const trackLast = board.lapSquares - 1;
  const homeStart = board.lapSquares;
  const homeLast = homeStart + board.homeColumnLength - 1;
  return { ...board, trackLast, homeStart, homeLast, finish: homeLast + 1 };
}

const BOARD_CACHE = new Map<string, LudoBoardSpec>();

export function boardFor(rulesVersion: LudoRulesVersion | string): LudoBoardSpec {
  const cached = BOARD_CACHE.get(rulesVersion);
  if (cached) return cached;
  const spec = resolveBoard(rulesFor(rulesVersion).board);
  BOARD_CACHE.set(rulesVersion, spec);
  return spec;
}

export function boardOf(state: { rulesVersion: string }): LudoBoardSpec {
  return boardFor(state.rulesVersion);
}

export function isCommonTrackProgress(board: LudoBoardSpec, progress: number): boolean {
  return progress >= 0 && progress <= board.trackLast;
}

export function isHomePathProgress(board: LudoBoardSpec, progress: number): boolean {
  return progress >= board.homeStart && progress <= board.homeLast;
}

export function isFinishedProgress(board: LudoBoardSpec, progress: number): boolean {
  return progress === board.finish;
}

export function toGlobalTrackIndex(board: LudoBoardSpec, color: LudoColor, progress: number): number {
  if (!isCommonTrackProgress(board, progress)) {
    throw new RangeError(`Progress ${progress} is not on the common track.`);
  }
  return (LUDO_START_INDEX[color] + progress) % board.trackLength;
}

export function isSafeGlobalSquare(index: number): boolean {
  if (!Number.isInteger(index) || index < 0 || index >= 52) return false;
  return LUDO_SAFE_GLOBAL_SQUARES.has(index);
}

export function canFinishWithRoll(board: LudoBoardSpec, progress: number, dice: number): boolean {
  if (!Number.isInteger(dice) || dice < 1 || dice > 6) return false;
  if (progress < 0 || progress >= board.finish) return false;
  return progress + dice <= board.finish;
}

/**
 * Every progress value a token visits for a move, including where it starts.
 * Leaving the yard is a single hop onto the start square.
 */
export function progressPath(fromProgress: number, toProgress: number): number[] {
  if (fromProgress < 0) return [fromProgress, 0];
  if (toProgress <= fromProgress) return [fromProgress, toProgress];
  const path: number[] = [];
  for (let progress = fromProgress; progress <= toProgress; progress += 1) path.push(progress);
  return path;
}

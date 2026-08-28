import { LudoColor } from './ludo.types';

export const LUDO_BASE_PROGRESS = -1;
export const LUDO_TRACK_LAST_PROGRESS = 51;
export const LUDO_HOME_START_PROGRESS = 52;
export const LUDO_HOME_LAST_PROGRESS = 56;
export const LUDO_FINISH_PROGRESS = 57;

/** Global 52-cell common-track start index for each color. */
export const LUDO_START_INDEX: Record<LudoColor, number> = {
  [LudoColor.RED]: 0,
  [LudoColor.GREEN]: 13,
  [LudoColor.YELLOW]: 26,
  [LudoColor.BLUE]: 39,
};

/**
 * Friends Game Hub LUDO_CLASSIC_V1 safe-square map.
 * This exact numeric map is a project rule choice for the canonical 52-cell track.
 */
export const LUDO_SAFE_GLOBAL_SQUARES = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

export function isCommonTrackProgress(progress: number): boolean {
  return progress >= 0 && progress <= LUDO_TRACK_LAST_PROGRESS;
}

export function isHomePathProgress(progress: number): boolean {
  return progress >= LUDO_HOME_START_PROGRESS && progress <= LUDO_HOME_LAST_PROGRESS;
}

export function isFinishedProgress(progress: number): boolean {
  return progress === LUDO_FINISH_PROGRESS;
}

export function toGlobalTrackIndex(color: LudoColor, progress: number): number {
  if (!isCommonTrackProgress(progress)) {
    throw new RangeError(`Progress ${progress} is not on the common track.`);
  }
  return (LUDO_START_INDEX[color] + progress) % 52;
}

export function isSafeGlobalSquare(index: number): boolean {
  if (!Number.isInteger(index) || index < 0 || index >= 52) return false;
  return LUDO_SAFE_GLOBAL_SQUARES.has(index);
}

export function canFinishWithRoll(progress: number, dice: number): boolean {
  if (!Number.isInteger(dice) || dice < 1 || dice > 6) return false;
  if (progress < 0 || progress >= LUDO_FINISH_PROGRESS) return false;
  return progress + dice <= LUDO_FINISH_PROGRESS;
}

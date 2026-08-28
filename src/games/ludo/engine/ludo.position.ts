import {
  LUDO_FINISH_PROGRESS,
  LUDO_TRACK_LAST_PROGRESS,
  isCommonTrackProgress,
  toGlobalTrackIndex,
} from '../domain';
import { LudoColor, LudoGameState, LudoToken } from '../domain';

export function getTokenById(state: LudoGameState, tokenId: string): LudoToken | null {
  for (const player of state.players) {
    const token = player.tokens.find((item) => item.id === tokenId);
    if (token) return token;
  }
  return null;
}

export function getPlayerTokensOnGlobalSquare(
  state: LudoGameState,
  ownerId: string,
  globalSquare: number,
): LudoToken[] {
  const player = state.players.find((item) => item.userId === ownerId);
  if (!player) return [];
  return player.tokens.filter(
    (token) =>
      isCommonTrackProgress(token.progress) &&
      toGlobalTrackIndex(token.color, token.progress) === globalSquare,
  );
}

export function getOpponentTokensOnGlobalSquare(
  state: LudoGameState,
  ownerId: string,
  globalSquare: number,
): LudoToken[] {
  return state.players
    .filter((player) => player.userId !== ownerId)
    .flatMap((player) =>
      player.tokens.filter(
        (token) =>
          isCommonTrackProgress(token.progress) &&
          toGlobalTrackIndex(token.color, token.progress) === globalSquare,
      ),
    );
}

export function getOpponentBlockadeSquares(state: LudoGameState, ownerId: string): Set<number> {
  const counts = new Map<string, { square: number; count: number }>();

  for (const player of state.players) {
    if (player.userId === ownerId) continue;
    for (const token of player.tokens) {
      if (!isCommonTrackProgress(token.progress)) continue;
      const square = toGlobalTrackIndex(token.color, token.progress);
      const key = `${player.userId}:${square}`;
      const previous = counts.get(key);
      counts.set(key, { square, count: (previous?.count ?? 0) + 1 });
    }
  }

  return new Set(
    [...counts.values()].filter((entry) => entry.count >= 2).map((entry) => entry.square),
  );
}

/**
 * Returns the common-track global squares crossed after leaving the current
 * location. Home-column cells are intentionally omitted because they are
 * private to the token owner and cannot contain opponent blockades.
 */
export function getTraversedCommonTrackSquares(
  color: LudoColor,
  fromProgress: number,
  toProgress: number,
): number[] {
  if (toProgress <= fromProgress) return [];
  const start = Math.max(fromProgress + 1, 0);
  const end = Math.min(toProgress, LUDO_TRACK_LAST_PROGRESS);
  const result: number[] = [];
  for (let progress = start; progress <= end; progress += 1) {
    result.push(toGlobalTrackIndex(color, progress));
  }
  return result;
}

export function isProgressWithinFinish(progress: number): boolean {
  return Number.isInteger(progress) && progress >= 0 && progress <= LUDO_FINISH_PROGRESS;
}

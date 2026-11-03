import { MatchStatus } from '../generated/prisma/enums';

/** Match the player should reconnect to / recover. */
export const RECOVERABLE_MATCH_STATUSES: MatchStatus[] = [
  MatchStatus.READY,
  MatchStatus.PLAYING,
  MatchStatus.FINISHING,
];

/**
 * Match that means the player must not open another paid commitment
 * (includes unsecured CREATED/WAITING open entries).
 */
export const COMMITTED_MATCH_STATUSES: MatchStatus[] = [
  MatchStatus.CREATED,
  MatchStatus.WAITING,
  MatchStatus.READY,
  MatchStatus.PLAYING,
  MatchStatus.FINISHING,
];

/** Pre-game statuses eligible for orphan maintenance cancellation. */
export const PREMATCH_ORPHAN_STATUSES: MatchStatus[] = [
  MatchStatus.CREATED,
  MatchStatus.WAITING,
];

export function isRecoverableMatchStatus(status: MatchStatus): boolean {
  return RECOVERABLE_MATCH_STATUSES.includes(status);
}

export function isCommittedMatchStatus(status: MatchStatus): boolean {
  return COMMITTED_MATCH_STATUSES.includes(status);
}

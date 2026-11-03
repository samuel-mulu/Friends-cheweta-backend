import { LobbyPlayerView } from '../lobby/lobby.types';

/**
 * PENDING → ACCEPTING → ACCEPTED, or PENDING → REJECTED | CANCELLED | EXPIRED.
 * ACCEPTING can only end as ACCEPTED (a match exists) or CANCELLED by the
 * accept path itself when match creation fails. Users cannot cancel it.
 */
export type ChallengeStatus =
  'PENDING' | 'ACCEPTING' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED';

/** Stored in Redis. Fields are strings/numbers only so Lua can re-encode it safely. */
export type ChallengeRecord = {
  id: string;
  gameModeId: string;
  challengerId: string;
  opponentId: string;
  status: ChallengeStatus;
  createdAt: string;
  expiresAt: string;
  expiresAtMs: number;
  acceptingAtMs?: number;
  matchId?: string;
};

export type ChallengeView = ChallengeRecord & {
  challengerName?: string;
  opponentName?: string;
  match?: { id: string } & Record<string, unknown>;
};

export type ChallengeEventName =
  'challenge:accepted' | 'challenge:rejected' | 'challenge:cancelled' | 'challenge:expired';

/** Everything the realtime layer must broadcast after a challenge resolves. */
export type ChallengeTransition = {
  event: ChallengeEventName;
  challenge: ChallengeView;
  /** Players returned to READY in the lobby. */
  restoredPlayers: LobbyPlayerView[];
  /** Players removed from the lobby because they are now in a match. */
  leftUserIds: string[];
  /** `match:ready` deliveries (the accepted match, or a player's existing match). */
  matchReady: Array<{ userId: string; match: { id: string } }>;
};

/** Thrown when accept fails; carries the cleanup transition that must still be broadcast. */
export class ChallengeAcceptFailedError extends Error {
  constructor(
    readonly reason: unknown,
    readonly transition: ChallengeTransition,
  ) {
    super(reason instanceof Error ? reason.message : 'CHALLENGE_ACCEPT_FAILED');
  }
}

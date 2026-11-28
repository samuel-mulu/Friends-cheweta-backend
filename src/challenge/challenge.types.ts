import { LobbyPlayerView } from '../lobby/lobby.types';

/**
 * PENDING → ACCEPTING → ACCEPTED, or PENDING → REJECTED | CANCELLED | EXPIRED.
 * ACCEPTING can only end as ACCEPTED (a match exists) or CANCELLED by the
 * accept path itself when match creation fails. Users cannot cancel it.
 */
export type ChallengeStatus =
  'PENDING' | 'ACCEPTING' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED';

/**
 * LOBBY: both players READY in the same lobby.
 * REMATCH: the two players of a finished match; no lobby involved.
 * INVITE: opponent unknown until someone joins with `inviteCode`.
 * AUTO: two players READY at the same terms, paired by the server (created
 * directly as ACCEPTING; nobody answers it).
 */
export type ChallengeKind = 'LOBBY' | 'REMATCH' | 'INVITE' | 'AUTO';

/** Stored in Redis. Fields are strings/numbers only so Lua can re-encode it safely. */
export type ChallengeRecord = {
  id: string;
  /** Absent on records written before kinds existed; treat as LOBBY. */
  kind?: ChallengeKind;
  sourceMatchId?: string;
  inviteCode?: string;
  gameModeId: string;
  challengerId: string;
  opponentId: string;
  status: ChallengeStatus;
  createdAt: string;
  expiresAt: string;
  expiresAtMs: number;
  acceptingAtMs?: number;
  matchId?: string;
  /** "First to N home" (1-4); absent = 4. Copied to the match on accept. */
  tokensToWin?: number;
  /**
   * A 3–4 player table (AUTO only): every seat in seat order, challenger
   * first. Absent on 1v1 records, whose seats are challenger and opponent.
   */
  playerIds?: string[];
};

/** Every player of a request, in seat order. */
export const seatsOf = (record: ChallengeRecord): string[] =>
  record.playerIds?.length ? record.playerIds : [record.challengerId, record.opponentId];

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

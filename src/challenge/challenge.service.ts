import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomInt, randomUUID } from 'node:crypto';
import { COMMITTED_MATCH_STATUSES } from '../common/match-status';
import { MatchStatus } from '../generated/prisma/enums';
import { LobbyService } from '../lobby/lobby.service';
import { DEFAULT_TOKENS_TO_WIN, LOBBY_TTL_SECONDS, LobbyUserContext } from '../lobby/lobby.types';
import { MatchCreationService, MatchSource } from '../match-creation/match-creation.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import {
  ChallengeAcceptFailedError,
  ChallengeEventName,
  ChallengeKind,
  ChallengeRecord,
  ChallengeTransition,
  ChallengeView,
  seatsOf,
} from './challenge.types';
import { isAutoTable, isKartaTable, playersPerMatch } from '../gaming/player-counts';

type MatchSummary = { id: string; participants?: Array<{ userId: string; seat: number }> } & Record<
  string,
  unknown
>;

/** How long an opponent has to answer. */
const CHALLENGE_TTL_MS = 15_000;
/** Redis retention for challenge records/reservations; status transitions, not TTLs, end a challenge. */
const RECORD_TTL_SECONDS = 300;
/** An ACCEPTING challenge older than this is resolved by the sweep (match creation is bounded well below it). */
const STALE_ACCEPTING_MS = 60_000;
const COMMAND_TTL_SECONDS = 300;
/** A rematch offer stays open this long; it can be requested this long after the match finished. */
const REMATCH_TTL_MS = 30_000;
const REMATCH_WINDOW_MS = 10 * 60_000;
/** Invite codes: 10 chars from a 32-symbol alphabet (50 bits), valid for 10 minutes. */
const INVITE_TTL_MS = 10 * 60_000;
const INVITE_CODE_LENGTH = 10;
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const MATCH_SOURCE: Record<ChallengeKind, MatchSource> = {
  LOBBY: 'CHALLENGE',
  REMATCH: 'REMATCH',
  INVITE: 'INVITE',
  // An automatic pairing is a lobby pairing the server made.
  AUTO: 'CHALLENGE',
};

/** Ready players looked at (oldest first) when pairing someone automatically. */
const AUTO_PAIR_SCAN = 20;
/** Re-scans when a chosen player was taken meanwhile. */
const AUTO_PAIR_ATTEMPTS = 3;

const tableAutoOnly = () =>
  new ConflictException({
    code: 'TABLE_AUTO_ONLY',
    message: "This table fills by itself: tap I'm ready.",
  });
/** A pair that just failed to start, or where one declined the other, is not auto-paired again for this long. */
const PAIR_COOLDOWN_SECONDS = 30;

/** Same automatic-match terms: both want it, and (Ludo) the same goal. Stake/type = same game mode. */
function sameAutoTerms(a: LobbyUserContext, b: LobbyUserContext): boolean {
  return (
    a.gameModeId === b.gameModeId &&
    a.state === 'READY' &&
    b.state === 'READY' &&
    a.autoMatch !== false &&
    b.autoMatch !== false &&
    (a.tokensToWin ?? DEFAULT_TOKENS_TO_WIN) === (b.tokensToWin ?? DEFAULT_TOKENS_TO_WIN)
  );
}

@Injectable()
export class ChallengeService {
  private readonly logger = new Logger(ChallengeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly lobby: LobbyService,
    private readonly matchCreation: MatchCreationService,
  ) {}

  async create(
    challengerId: string,
    opponentId: string,
    commandId: string,
    tokensToWin = 4,
  ): Promise<{ challenge: ChallengeView; duplicate: boolean }> {
    const duplicate = await this.commandResult(commandId, challengerId);
    if (duplicate) return { challenge: await this.view(duplicate.challengeId), duplicate: true };
    if (challengerId === opponentId)
      throw new ConflictException({
        code: 'CHALLENGE_SELF_NOT_ALLOWED',
        message: 'You cannot challenge yourself.',
      });

    const [challenger, opponent] = await Promise.all([
      this.lobby.requireContext(challengerId),
      this.lobby.requireContext(opponentId),
    ]);
    if (challenger.gameModeId !== opponent.gameModeId)
      throw new ConflictException({
        code: 'LOBBY_DIFFERENT_MODE',
        message: 'Player is in a different lobby.',
      });
    const mode = await this.lobby.assertCanPlay([challengerId, opponentId], challenger.gameModeId);
    if (isAutoTable(mode)) throw tableAutoOnly();

    const now = Date.now();
    const record: ChallengeRecord = {
      id: randomUUID(),
      kind: 'LOBBY',
      gameModeId: challenger.gameModeId,
      challengerId,
      opponentId,
      status: 'PENDING',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + CHALLENGE_TTL_MS).toISOString(),
      expiresAtMs: now + CHALLENGE_TTL_MS,
      // The waiting player said what they play (Ludo goal); the request plays that.
      tokensToWin: opponent.tokensToWin ?? tokensToWin,
    };

    const result = (await this.redis.raw().eval(RESERVE_SCRIPT, {
      keys: [
        this.contextKey(challengerId),
        this.contextKey(opponentId),
        this.reservationKey(challengerId),
        this.reservationKey(opponentId),
        this.challengeKey(record.id),
        this.readyKey(record.gameModeId),
        this.expiresKey(),
      ],
      arguments: [
        JSON.stringify(record),
        record.id,
        String(record.expiresAtMs),
        String(RECORD_TTL_SECONDS),
        String(LOBBY_TTL_SECONDS),
      ],
    })) as string;
    if (result !== 'OK')
      throw new ConflictException({ code: result, message: 'Challenge could not be created.' });
    await this.storeCommand(commandId, challengerId, record.id);
    return { challenge: await this.toView(record), duplicate: false };
  }

  /**
   * Exactly one accept can claim PENDING → ACCEPTING; the database
   * (Match.challengeId UNIQUE) decides whether a match exists. Either a
   * transition is returned, or ChallengeAcceptFailedError carries the cleanup.
   */
  async accept(
    userId: string,
    challengeId: string,
    commandId: string,
  ): Promise<ChallengeTransition & { duplicate: boolean }> {
    const duplicate = await this.commandResult(commandId, userId);
    const existing = await this.findMatch(challengeId);
    if (existing) {
      if (!existing.participants?.some((participant) => participant.userId === userId)) {
        throw new ForbiddenException({
          code: 'CHALLENGE_NOT_OPPONENT',
          message: 'Only opponent can accept.',
        });
      }
      const transition = await this.markAccepted(challengeId, existing);
      await this.storeCommand(commandId, userId, challengeId);
      return { ...transition, duplicate: Boolean(duplicate) };
    }
    if (duplicate)
      throw new ConflictException({
        code: 'CHALLENGE_NOT_PENDING',
        message: 'Challenge is no longer pending.',
      });

    const challenge = await this.requireRecord(challengeId);
    if (challenge.opponentId !== userId)
      throw new ForbiddenException({
        code: 'CHALLENGE_NOT_OPPONENT',
        message: 'Only opponent can accept.',
      });

    const claim = (await this.redis.raw().eval(CLAIM_ACCEPT_SCRIPT, {
      keys: [
        this.challengeKey(challengeId),
        this.reservationKey(challenge.challengerId),
        this.reservationKey(challenge.opponentId),
      ],
      arguments: [challengeId, String(Date.now()), String(RECORD_TTL_SECONDS)],
    })) as string;
    if (claim === 'CHALLENGE_EXPIRED') {
      const expired = await this.finish(challenge, 'EXPIRED', 'challenge:expired');
      throw new ChallengeAcceptFailedError(
        new ConflictException({ code: 'CHALLENGE_EXPIRED', message: 'Challenge has expired.' }),
        expired ?? this.emptyTransition(challenge, 'challenge:expired'),
      );
    }
    if (claim !== 'OK')
      throw new ConflictException({ code: claim, message: 'Challenge is no longer pending.' });

    return this.completeAccept(challenge, userId, commandId);
  }

  /**
   * Automatic matching: seat [userId] (just READY) with the players who have
   * waited longest at the same terms — same game mode (game, type, stake),
   * auto-match on, and (Ludo) the same goal — and start the match once every
   * seat is filled (2 for 1v1, 3–4 for a Ludo table). Fewer: keep waiting.
   *
   * Race-safe with manual requests and with other pairings: PAIR_SCRIPT
   * re-checks every player atomically (READY, no open request) and reserves
   * them all or none, creating the record directly as ACCEPTING; from there
   * the normal accept path creates the match (Match.challengeId is unique) or
   * releases everyone back to READY. Returns the transition to broadcast, or
   * null when the seats could not be filled.
   */
  async autoPair(userId: string): Promise<ChallengeTransition | null> {
    const me = await this.lobby.getContext(userId);
    if (!me || me.state !== 'READY' || me.autoMatch === false) return null;
    let seats: number;
    try {
      seats = playersPerMatch(await this.lobby.assertCanPlay([userId], me.gameModeId));
    } catch {
      return null; // I can't play right now (balance, or already in a match)
    }

    for (let attempt = 0; attempt < AUTO_PAIR_ATTEMPTS; attempt += 1) {
      const others = await this.waitingPartners(me, userId, seats - 1);
      if (others.length < seats - 1) return null; // not enough players yet

      // Longest waiting first (seat order); I take the last seat.
      const playerIds = [...others, userId];
      const record = this.newRecord(
        'AUTO',
        me.gameModeId,
        playerIds[0],
        playerIds[1],
        CHALLENGE_TTL_MS,
        {
          status: 'ACCEPTING',
          acceptingAtMs: Date.now(),
          ...(me.tokensToWin ? { tokensToWin: me.tokensToWin } : {}),
          ...(seats > 2 ? { playerIds } : {}),
        },
      );
      const result = (await this.redis.raw().eval(PAIR_SCRIPT, {
        keys: [
          this.challengeKey(record.id),
          this.readyKey(record.gameModeId),
          this.expiresKey(),
          ...playerIds.map((id) => this.contextKey(id)),
          ...playerIds.map((id) => this.reservationKey(id)),
        ],
        arguments: [
          JSON.stringify(record),
          record.id,
          String(record.expiresAtMs),
          String(RECORD_TTL_SECONDS),
          String(LOBBY_TTL_SECONDS),
          String(DEFAULT_TOKENS_TO_WIN),
          String(playerIds.length),
          ...playerIds,
        ],
      })) as string;
      if (result === 'NOT_READY' && !(await this.stillWaiting(userId))) return null; // I was taken meanwhile
      if (result !== 'OK') continue; // someone was taken or changed meanwhile: look again

      this.logger.log(`auto_pair_started challenge=${record.id} players=${playerIds.join(',')}`);
      try {
        return await this.completeAccept(record, userId, `auto:${record.id}`);
      } catch (error) {
        if (!(error instanceof ChallengeAcceptFailedError)) throw error;
        // Everyone is back to READY; don't seat me with them again at once.
        for (const otherId of others) await this.coolDownPair(otherId, userId);
        return error.transition;
      }
    }
    return null;
  }

  /** Up to [count] players ready at my terms who could play now, longest waiting first. */
  private async waitingPartners(
    me: LobbyUserContext,
    userId: string,
    count: number,
  ): Promise<string[]> {
    const waiting = await this.redis
      .raw()
      .zRange(this.readyKey(me.gameModeId), 0, AUTO_PAIR_SCAN - 1); // oldest first
    const partners: string[] = [];
    for (const otherId of waiting) {
      if (partners.length === count) break;
      if (otherId === userId) continue;
      const other = await this.lobby.getContext(otherId);
      if (!other || !sameAutoTerms(other, me)) continue;
      if (await this.redis.raw().exists(this.pairCooldownKey(otherId, userId))) continue;
      try {
        await this.lobby.assertCanPlay([otherId], me.gameModeId);
      } catch {
        continue; // e.g. balance, or already in a match: try the next player
      }
      partners.push(otherId);
    }
    return partners;
  }

  private async stillWaiting(userId: string): Promise<boolean> {
    const context = await this.lobby.getContext(userId);
    return context?.state === 'READY';
  }

  /** Keep two players apart from automatic pairing for a moment. */
  private async coolDownPair(a: string, b: string): Promise<void> {
    await this.redis.raw().set(this.pairCooldownKey(a, b), '1', { EX: PAIR_COOLDOWN_SECONDS });
  }

  /**
   * Offer a rematch to the other player of a recently finished match. Uses
   * the same accept/reject/cancel/expiry path as lobby challenges.
   */
  async createRematch(
    userId: string,
    matchId: string,
    commandId: string,
  ): Promise<{ challenge: ChallengeView; duplicate: boolean }> {
    const duplicate = await this.commandResult(commandId, userId);
    if (duplicate) return { challenge: await this.view(duplicate.challengeId), duplicate: true };

    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: {
        status: true,
        gameModeId: true,
        finishedAt: true,
        source: true,
        tokensToWin: true,
        participants: { select: { userId: true } },
      },
    });
    if (!match)
      throw new NotFoundException({ code: 'MATCH_NOT_FOUND', message: 'Match not found.' });
    const playerIds = match.participants.map((participant) => participant.userId);
    if (!playerIds.includes(userId)) {
      throw new ForbiddenException({
        code: 'MATCH_ACCESS_DENIED',
        message: 'You are not part of this match.',
      });
    }
    // Practice games restart from Practice ("Play again"), not as a rematch.
    if (
      match.status !== MatchStatus.FINISHED ||
      playerIds.length !== 2 ||
      match.source === 'PRACTICE'
    ) {
      throw new ConflictException({
        code: 'REMATCH_NOT_AVAILABLE',
        message: 'Only a finished match can be rematched.',
      });
    }
    if (!match.finishedAt || Date.now() - match.finishedAt.getTime() > REMATCH_WINDOW_MS) {
      throw new ConflictException({
        code: 'REMATCH_EXPIRED',
        message: 'The rematch window has closed.',
      });
    }
    const opponentId = playerIds.find((id) => id !== userId)!;
    const mode = await this.lobby.assertCanPlay([userId, opponentId], match.gameModeId);
    // A Karta table carries on by itself; a 3–4 player table refills itself.
    if (isAutoTable(mode) || isKartaTable(mode.rulesVersion)) {
      throw new ConflictException({
        code: 'REMATCH_NOT_AVAILABLE',
        message: 'Tables start again from the lobby.',
      });
    }

    // A rematch is the same game again, goal included.
    const record = this.newRecord('REMATCH', match.gameModeId, userId, opponentId, REMATCH_TTL_MS, {
      sourceMatchId: matchId,
      tokensToWin: match.tokensToWin,
    });
    await this.reserveDirect(record, [userId, opponentId]);
    await this.storeCommand(commandId, userId, record.id);
    return { challenge: await this.toView(record), duplicate: false };
  }

  /** Create a shareable invite code for this mode; the first eligible player to join it plays. */
  async createInvite(
    userId: string,
    gameModeId: string,
    commandId: string,
    tokensToWin = 4,
  ): Promise<{ challenge: ChallengeView; duplicate: boolean }> {
    const duplicate = await this.commandResult(commandId, userId);
    if (duplicate) return { challenge: await this.view(duplicate.challengeId), duplicate: true };
    const mode = await this.lobby.assertCanPlay([userId], gameModeId);
    if (isAutoTable(mode)) throw tableAutoOnly();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const inviteCode = this.inviteCode();
      const record = this.newRecord('INVITE', gameModeId, userId, '', INVITE_TTL_MS, {
        inviteCode,
        tokensToWin,
      });
      if (!(await this.reserveDirect(record, [userId], this.inviteKey(inviteCode)))) continue; // code collision
      await this.storeCommand(commandId, userId, record.id);
      return { challenge: await this.toView(record), duplicate: false };
    }
    throw new ConflictException({
      code: 'INVITE_CODE_UNAVAILABLE',
      message: 'Could not create an invite. Please try again.',
    });
  }

  /** Join an invite by code. Joining is accepting: it creates the match. */
  async joinInvite(
    userId: string,
    rawCode: string,
    commandId: string,
  ): Promise<ChallengeTransition & { duplicate: boolean }> {
    const code = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const duplicate = await this.commandResult(commandId, userId);
    if (duplicate) {
      const match = await this.findMatch(duplicate.challengeId);
      if (match)
        return { ...(await this.markAccepted(duplicate.challengeId, match)), duplicate: true };
    }

    const challengeId = await this.redis.raw().get(this.inviteKey(code));
    const challenge = challengeId
      ? await this.redis.getJson<ChallengeRecord>(this.challengeKey(challengeId))
      : null;
    if (!challenge || challenge.kind !== 'INVITE') {
      throw new NotFoundException({ code: 'INVITE_NOT_FOUND', message: 'Invite code not found.' });
    }
    if (challenge.challengerId === userId) {
      throw new ConflictException({
        code: 'INVITE_SELF',
        message: 'You cannot join your own invite.',
      });
    }
    await this.lobby.assertCanPlay([challenge.challengerId, userId], challenge.gameModeId);

    const claim = (await this.redis.raw().eval(CLAIM_INVITE_SCRIPT, {
      keys: [
        this.challengeKey(challenge.id),
        this.reservationKey(challenge.challengerId),
        this.reservationKey(userId),
      ],
      arguments: [challenge.id, userId, String(Date.now()), String(RECORD_TTL_SECONDS)],
    })) as string;
    if (claim === 'CHALLENGE_EXPIRED') {
      const expired = await this.finish(challenge, 'EXPIRED', 'challenge:expired');
      throw new ChallengeAcceptFailedError(
        new ConflictException({ code: 'CHALLENGE_EXPIRED', message: 'Invite has expired.' }),
        expired ?? this.emptyTransition(challenge, 'challenge:expired'),
      );
    }
    if (claim !== 'OK')
      throw new ConflictException({ code: claim, message: 'Invite is no longer available.' });
    return this.completeAccept({ ...challenge, opponentId: userId }, userId, commandId);
  }

  /** After a successful claim (status ACCEPTING): create the match, or release the claim on failure. */
  private async completeAccept(
    challenge: ChallengeRecord,
    userId: string,
    commandId: string,
  ): Promise<ChallengeTransition & { duplicate: boolean }> {
    const challengeId = challenge.id;
    this.logger.log(`challenge_accept_started challenge=${challengeId} command=${commandId}`);
    let match: MatchSummary;
    try {
      match = await this.matchCreation.createSecuredMatch({
        gameModeId: challenge.gameModeId,
        playerIds: seatsOf(challenge),
        challengeId,
        source: MATCH_SOURCE[challenge.kind ?? 'LOBBY'],
        rematchOfMatchId: challenge.sourceMatchId,
        tokensToWin: challenge.tokensToWin,
      });
    } catch (error) {
      // The transaction may have committed even though the call failed.
      const committed = await this.findMatch(challengeId).catch(() => null);
      if (!committed) {
        this.logger.warn(
          `challenge_accept_failed challenge=${challengeId} reason=${error instanceof Error ? error.message : 'unknown'}`,
        );
        // Business rejections (balance, active match…) keep their code; anything
        // unexpected (database timeout…) becomes a readable, retryable error.
        const reason =
          error instanceof HttpException
            ? error
            : new ServiceUnavailableException({
                code: 'MATCH_CREATION_FAILED',
                message: 'Could not start the match. Please try again.',
              });
        throw new ChallengeAcceptFailedError(reason, await this.releaseFailedAccept(challenge));
      }
      match = committed;
    }

    const transition = await this.markAccepted(challengeId, match);
    await this.storeCommand(commandId, userId, challengeId);
    this.logger.log(`challenge_match_created challenge=${challengeId} match=${match.id}`);
    return { ...transition, duplicate: false };
  }

  async reject(
    userId: string,
    challengeId: string,
    commandId: string,
  ): Promise<ChallengeTransition & { duplicate: boolean }> {
    return this.userTerminal(
      userId,
      challengeId,
      commandId,
      'opponentId',
      'REJECTED',
      'challenge:rejected',
    );
  }

  async cancel(
    userId: string,
    challengeId: string,
    commandId: string,
  ): Promise<ChallengeTransition & { duplicate: boolean }> {
    return this.userTerminal(
      userId,
      challengeId,
      commandId,
      'challengerId',
      'CANCELLED',
      'challenge:cancelled',
    );
  }

  /** Disconnect/leave: cancel a PENDING challenge. An in-flight accept is left to finish. */
  async cancelForUser(userId: string): Promise<ChallengeTransition | null> {
    const challengeId = await this.redis.raw().get(this.reservationKey(userId));
    if (!challengeId) return null;
    const challenge = await this.redis.getJson<ChallengeRecord>(this.challengeKey(challengeId));
    if (!challenge) return null;
    return this.finish(challenge, 'CANCELLED', 'challenge:cancelled', { excludeUserId: userId });
  }

  async activeForUser(userId: string): Promise<ChallengeView | null> {
    const challengeId = await this.redis.raw().get(this.reservationKey(userId));
    if (!challengeId) return null;
    const challenge = await this.redis.getJson<ChallengeRecord>(this.challengeKey(challengeId));
    return challenge && (challenge.status === 'PENDING' || challenge.status === 'ACCEPTING')
      ? this.toView(challenge)
      : null;
  }

  /** Periodic sweep: expire unanswered challenges and resolve stuck accepts. */
  async sweep(nowMs = Date.now()): Promise<ChallengeTransition[]> {
    const ids = await this.redis
      .raw()
      .zRangeByScore(this.expiresKey(), 0, nowMs, { LIMIT: { offset: 0, count: 25 } });
    const transitions: ChallengeTransition[] = [];
    for (const id of ids) {
      try {
        const transition = await this.sweepOne(id, nowMs);
        if (transition) transitions.push(transition);
      } catch (error) {
        this.logger.warn(
          `challenge_sweep_failed challenge=${id} reason=${(error as Error).message}`,
        );
      }
    }
    return transitions;
  }

  private async sweepOne(id: string, nowMs: number): Promise<ChallengeTransition | null> {
    const challenge = await this.redis.getJson<ChallengeRecord>(this.challengeKey(id));
    if (!challenge || (challenge.status !== 'PENDING' && challenge.status !== 'ACCEPTING')) {
      await this.redis.raw().zRem(this.expiresKey(), id);
      return null;
    }
    if (challenge.status === 'PENDING')
      return this.finish(challenge, 'EXPIRED', 'challenge:expired');
    if (nowMs - (challenge.acceptingAtMs ?? 0) < STALE_ACCEPTING_MS) return null;

    // The accepting process died. PostgreSQL decides the outcome.
    const match = await this.findMatch(id);
    if (match) return this.markAccepted(id, match);
    this.logger.warn(`challenge_stale_accept_released challenge=${id}`);
    return this.releaseFailedAccept(challenge);
  }

  private async userTerminal(
    userId: string,
    challengeId: string,
    commandId: string,
    role: 'challengerId' | 'opponentId',
    status: 'REJECTED' | 'CANCELLED',
    event: ChallengeEventName,
  ): Promise<ChallengeTransition & { duplicate: boolean }> {
    const challenge = await this.requireRecord(challengeId);
    const duplicate = await this.commandResult(commandId, userId);
    if (duplicate && challenge.status === status) {
      return { ...this.emptyTransition(await this.toView(challenge), event), duplicate: true };
    }
    if (challenge[role] !== userId) {
      throw new ForbiddenException({
        code: role === 'opponentId' ? 'CHALLENGE_NOT_OPPONENT' : 'CHALLENGE_NOT_CHALLENGER',
        message: 'You cannot change this challenge.',
      });
    }
    const transition = await this.finish(challenge, status, event);
    if (!transition)
      throw new ConflictException({
        code: 'CHALLENGE_NOT_PENDING',
        message: 'Challenge is no longer pending.',
      });
    // Someone who just said no is not auto-paired with the same player right away.
    if (status === 'REJECTED')
      await this.coolDownPair(challenge.challengerId, challenge.opponentId);
    await this.storeCommand(commandId, userId, challengeId);
    return { ...transition, duplicate: false };
  }

  /**
   * Atomically end a challenge and return CHALLENGED players to READY. Returns
   * null when the challenge already left PENDING (or is ACCEPTING and
   * `allowAccepting` is not set).
   */
  private async finish(
    challenge: ChallengeRecord,
    status: 'REJECTED' | 'CANCELLED' | 'EXPIRED',
    event: ChallengeEventName,
    options: { allowAccepting?: boolean; excludeUserId?: string } = {},
  ): Promise<ChallengeTransition | null> {
    const now = Date.now();
    const seats = seatsOf(challenge);
    const result = (await this.redis.raw().eval(TERMINAL_SCRIPT, {
      keys: [
        this.challengeKey(challenge.id),
        this.readyKey(challenge.gameModeId),
        this.expiresKey(),
        ...seats.map((id) => this.reservationKey(id)),
        ...seats.map((id) => this.contextKey(id)),
      ],
      arguments: [
        challenge.id,
        status,
        String(RECORD_TTL_SECONDS),
        String(now),
        new Date(now).toISOString(),
        options.allowAccepting ? '1' : '0',
        options.excludeUserId ?? '',
        String(LOBBY_TTL_SECONDS),
        String(seats.length),
        ...seats,
      ],
    })) as string | string[];
    if (!Array.isArray(result)) return null;
    const restoredIds = result.slice(1);
    return {
      event,
      challenge: await this.toView({ ...challenge, status }),
      restoredPlayers: await this.lobby.playerViews(restoredIds),
      leftUserIds: [],
      matchReady: [],
    };
  }

  /** Record the durable match on the challenge and take both players out of the lobby. Idempotent. */
  private async markAccepted(
    challengeId: string,
    match: MatchSummary,
  ): Promise<ChallengeTransition> {
    const participants = [...(match.participants ?? [])].sort((a, b) => a.seat - b.seat);
    const stored = await this.redis.getJson<ChallengeRecord>(this.challengeKey(challengeId));
    const record: ChallengeRecord = stored ?? {
      id: challengeId,
      gameModeId: typeof match.gameModeId === 'string' ? match.gameModeId : '',
      challengerId: participants[0]?.userId ?? '',
      opponentId: participants[1]?.userId ?? '',
      ...(participants.length > 2 ? { playerIds: participants.map((p) => p.userId) } : {}),
      status: 'ACCEPTED',
      createdAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
      expiresAtMs: Date.now(),
    };
    const playerIds = seatsOf(record);
    if (stored) {
      await this.redis.raw().eval(ACCEPTED_SCRIPT, {
        keys: [
          this.challengeKey(challengeId),
          this.readyKey(record.gameModeId),
          this.expiresKey(),
          ...playerIds.map((id) => this.reservationKey(id)),
          ...playerIds.map((id) => this.contextKey(id)),
        ],
        arguments: [
          challengeId,
          match.id,
          String(RECORD_TTL_SECONDS),
          String(playerIds.length),
          ...playerIds,
        ],
      });
    }
    return {
      event: 'challenge:accepted',
      challenge: {
        ...(await this.toView({ ...record, status: 'ACCEPTED', matchId: match.id })),
        match,
      },
      restoredPlayers: [],
      leftUserIds: playerIds,
      matchReady: playerIds.map((userId) => ({ userId, match })),
    };
  }

  /**
   * Match creation failed: cancel (allowed from ACCEPTING), keep eligible
   * players READY, and move players that already hold another match out of
   * the lobby and back to that match.
   */
  private async releaseFailedAccept(challenge: ChallengeRecord): Promise<ChallengeTransition> {
    const transition =
      (await this.finish(challenge, 'CANCELLED', 'challenge:cancelled', {
        allowAccepting: true,
      })) ??
      this.emptyTransition(
        await this.toView({ ...challenge, status: 'CANCELLED' }),
        'challenge:cancelled',
      );

    const committed = await this.prisma.matchParticipant.findMany({
      where: {
        userId: { in: seatsOf(challenge) },
        match: { status: { in: COMMITTED_MATCH_STATUSES } },
      },
      select: { userId: true },
    });
    for (const { userId } of committed) {
      await this.lobby.leave(userId).catch(() => undefined);
      transition.leftUserIds.push(userId);
      const activeMatch = await this.lobby.activeMatchForUser(userId).catch(() => null);
      if (activeMatch) transition.matchReady.push({ userId, match: activeMatch });
    }
    transition.restoredPlayers = transition.restoredPlayers.filter(
      (player) => !transition.leftUserIds.includes(player.userId),
    );
    return transition;
  }

  private newRecord(
    kind: ChallengeKind,
    gameModeId: string,
    challengerId: string,
    opponentId: string,
    ttlMs: number,
    extra: Partial<ChallengeRecord> = {},
  ): ChallengeRecord {
    const now = Date.now();
    return {
      id: randomUUID(),
      kind,
      gameModeId,
      challengerId,
      opponentId,
      status: 'PENDING',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
      expiresAtMs: now + ttlMs,
      ...extra,
    };
  }

  /**
   * Reserve a non-lobby challenge: each player may hold one open challenge.
   * Returns false only on an invite-code collision.
   */
  private async reserveDirect(
    record: ChallengeRecord,
    playerIds: string[],
    inviteKey?: string,
  ): Promise<boolean> {
    const ttlSeconds = Math.ceil((record.expiresAtMs - Date.now()) / 1000) + RECORD_TTL_SECONDS;
    const result = (await this.redis.raw().eval(RESERVE_DIRECT_SCRIPT, {
      keys: [
        this.challengeKey(record.id),
        this.expiresKey(),
        inviteKey ?? this.redis.key('challenge', 'invite', '-'),
        ...playerIds.map((id) => this.reservationKey(id)),
      ],
      arguments: [
        JSON.stringify(record),
        record.id,
        String(record.expiresAtMs),
        String(ttlSeconds),
        inviteKey ? '1' : '0',
      ],
    })) as string;
    if (result === 'INVITE_CODE_TAKEN') return false;
    if (result !== 'OK')
      throw new ConflictException({ code: result, message: 'A challenge is already pending.' });
    return true;
  }

  private inviteCode(): string {
    let code = '';
    for (let i = 0; i < INVITE_CODE_LENGTH; i += 1)
      code += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
    return code;
  }

  private async findMatch(challengeId: string): Promise<MatchSummary | null> {
    return await this.matchCreation.findByChallengeId(challengeId);
  }

  private emptyTransition(
    challenge: ChallengeView | ChallengeRecord,
    event: ChallengeEventName,
  ): ChallengeTransition {
    return { event, challenge, restoredPlayers: [], leftUserIds: [], matchReady: [] };
  }

  private async requireRecord(challengeId: string): Promise<ChallengeRecord> {
    const challenge = await this.redis.getJson<ChallengeRecord>(this.challengeKey(challengeId));
    if (!challenge)
      throw new NotFoundException({ code: 'CHALLENGE_NOT_FOUND', message: 'Challenge not found.' });
    return challenge;
  }

  private async view(challengeId: string): Promise<ChallengeView> {
    return this.toView(await this.requireRecord(challengeId));
  }

  private async toView(challenge: ChallengeRecord): Promise<ChallengeView> {
    const users = await this.prisma.user.findMany({
      where: { id: { in: [challenge.challengerId, challenge.opponentId] } },
      select: { id: true, fullName: true },
    });
    const name = (id: string) => users.find((user) => user.id === id)?.fullName;
    return {
      ...challenge,
      challengerName: name(challenge.challengerId),
      opponentName: name(challenge.opponentId),
    };
  }

  private async commandResult(
    commandId: string,
    userId: string,
  ): Promise<{ challengeId: string } | null> {
    return this.redis.getJson<{ challengeId: string }>(this.commandKey(userId, commandId));
  }

  private async storeCommand(
    commandId: string,
    userId: string,
    challengeId: string,
  ): Promise<void> {
    await this.redis.setJson(
      this.commandKey(userId, commandId),
      { challengeId },
      COMMAND_TTL_SECONDS,
    );
  }

  private inviteKey(code: string): string {
    return this.redis.key('challenge', 'invite', code);
  }

  /** Order-independent: the same key for (a, b) and (b, a). */
  private pairCooldownKey(a: string, b: string): string {
    const [first, second] = [a, b].sort();
    return this.redis.key('challenge', 'pair-cooldown', first, second);
  }

  private challengeKey(id: string): string {
    return this.redis.key('challenge', id);
  }
  private reservationKey(userId: string): string {
    return this.redis.key('challenge', 'user', userId);
  }
  private expiresKey(): string {
    return this.redis.key('challenge', 'expires');
  }
  private commandKey(userId: string, commandId: string): string {
    return this.redis.key('challenge', 'cmd', userId, commandId);
  }
  private contextKey(userId: string): string {
    return this.redis.key('lobby', 'user', userId);
  }
  private readyKey(gameModeId: string): string {
    return this.redis.key('lobby', gameModeId, 'ready');
  }
}

// KEYS: ctxA ctxB resA resB challenge ready expires
// ARGV: recordJson id expiresAtMs recordTtl ctxTtl
const RESERVE_SCRIPT = `
local aCtx = redis.call('get', KEYS[1])
local bCtx = redis.call('get', KEYS[2])
if not aCtx or not bCtx then return 'LOBBY_NOT_JOINED' end
local a = cjson.decode(aCtx)
local b = cjson.decode(bCtx)
if a.gameModeId ~= b.gameModeId then return 'LOBBY_DIFFERENT_MODE' end
-- Challenging is itself an intent to play: an ONLINE challenger is readied
-- by this same atomic step (only the target must already be READY).
if a.state ~= 'READY' and a.state ~= 'ONLINE' then return 'LOBBY_USER_BUSY' end
if b.state ~= 'READY' then return 'CHALLENGE_TARGET_NOT_READY' end
if redis.call('exists', KEYS[3]) == 1 or redis.call('exists', KEYS[4]) == 1 then return 'LOBBY_USER_BUSY' end
local record = cjson.decode(ARGV[1])
local ttl = tonumber(ARGV[4])
a.state = 'CHALLENGED'
b.state = 'CHALLENGED'
redis.call('set', KEYS[3], ARGV[2], 'EX', ttl)
redis.call('set', KEYS[4], ARGV[2], 'EX', ttl)
redis.call('set', KEYS[5], ARGV[1], 'EX', ttl)
redis.call('zrem', KEYS[6], record.challengerId, record.opponentId)
redis.call('set', KEYS[1], cjson.encode(a), 'EX', tonumber(ARGV[5]))
redis.call('set', KEYS[2], cjson.encode(b), 'EX', tonumber(ARGV[5]))
redis.call('zadd', KEYS[7], ARGV[3], ARGV[2])
return 'OK'`;

// Automatic pairing: every player must still be READY at the same terms with
// no open request; all are reserved and the record is stored as ACCEPTING in
// one atomic step (all or none), so a manual request (RESERVE_SCRIPT needs the
// target READY and unreserved) or another pairing racing it fails cleanly.
// KEYS: challenge ready expires ctx1..ctxN res1..resN
// ARGV: recordJson id expiresAtMs recordTtl ctxTtl defaultGoal N userId1..userIdN
const PAIR_SCRIPT = `
local n = tonumber(ARGV[7])
local defaultGoal = tonumber(ARGV[6])
local ctxs = {}
local modeId = nil
local goal = nil
for i = 1, n do
  local raw = redis.call('get', KEYS[3 + i])
  if not raw then return 'LOBBY_NOT_JOINED' end
  local ctx = cjson.decode(raw)
  if modeId == nil then modeId = ctx.gameModeId elseif ctx.gameModeId ~= modeId then return 'LOBBY_DIFFERENT_MODE' end
  if ctx.state ~= 'READY' then return 'NOT_READY' end
  if ctx.autoMatch == false then return 'AUTO_MATCH_OFF' end
  local g = tonumber(ctx.tokensToWin) or defaultGoal
  if goal == nil then goal = g elseif g ~= goal then return 'DIFFERENT_TERMS' end
  if redis.call('exists', KEYS[3 + n + i]) == 1 then return 'LOBBY_USER_BUSY' end
  ctxs[i] = ctx
end
local ttl = tonumber(ARGV[4])
redis.call('set', KEYS[1], ARGV[1], 'EX', ttl)
for i = 1, n do
  ctxs[i].state = 'CHALLENGED'
  redis.call('set', KEYS[3 + n + i], ARGV[2], 'EX', ttl)
  redis.call('set', KEYS[3 + i], cjson.encode(ctxs[i]), 'EX', tonumber(ARGV[5]))
  redis.call('zrem', KEYS[2], ARGV[7 + i])
end
redis.call('zadd', KEYS[3], ARGV[3], ARGV[2])
return 'OK'`;

// KEYS: challenge resA resB
// ARGV: id nowMs recordTtl
const CLAIM_ACCEPT_SCRIPT = `
local raw = redis.call('get', KEYS[1])
if not raw then return 'CHALLENGE_NOT_FOUND' end
local record = cjson.decode(raw)
if record.status ~= 'PENDING' then return 'CHALLENGE_NOT_PENDING' end
if tonumber(record.expiresAtMs) <= tonumber(ARGV[2]) then return 'CHALLENGE_EXPIRED' end
if redis.call('get', KEYS[2]) ~= ARGV[1] or redis.call('get', KEYS[3]) ~= ARGV[1] then return 'CHALLENGE_NOT_PENDING' end
record.status = 'ACCEPTING'
record.acceptingAtMs = tonumber(ARGV[2])
redis.call('set', KEYS[1], cjson.encode(record), 'EX', tonumber(ARGV[3]))
return 'OK'`;

// KEYS: challenge ready expires res1..resN ctx1..ctxN
// ARGV: id status recordTtl readyScore readyIso allowAccepting excludeUserId ctxTtl N userId1..userIdN
// Returns {'OK', restoredUserId...} or an error code string.
const TERMINAL_SCRIPT = `
local raw = redis.call('get', KEYS[1])
if not raw then return 'CHALLENGE_NOT_FOUND' end
local record = cjson.decode(raw)
if record.status == 'ACCEPTING' and ARGV[6] ~= '1' then return 'CHALLENGE_ACCEPTING' end
if record.status ~= 'PENDING' and record.status ~= 'ACCEPTING' then return 'ALREADY_TERMINAL' end
record.status = ARGV[2]
redis.call('set', KEYS[1], cjson.encode(record), 'EX', tonumber(ARGV[3]))
local n = tonumber(ARGV[9])
for i = 1, n do
  if redis.call('get', KEYS[3 + i]) == ARGV[1] then redis.call('del', KEYS[3 + i]) end
end
redis.call('zrem', KEYS[3], ARGV[1])
local restored = {'OK'}
for i = 1, n do
  local userId = ARGV[9 + i]
  local ctxKey = KEYS[3 + n + i]
  local ctxRaw = nil
  if userId ~= '' and userId ~= ARGV[7] then ctxRaw = redis.call('get', ctxKey) end
  if ctxRaw then
    local ctx = cjson.decode(ctxRaw)
    if ctx.state == 'CHALLENGED' and ctx.gameModeId == record.gameModeId then
      ctx.state = 'READY'
      ctx.readyAt = ARGV[5]
      redis.call('set', ctxKey, cjson.encode(ctx), 'EX', tonumber(ARGV[8]))
      redis.call('zadd', KEYS[2], ARGV[4], userId)
      table.insert(restored, userId)
    end
  end
end
return restored`;

// KEYS: challenge ready expires res1..resN ctx1..ctxN
// ARGV: id matchId recordTtl N userId1..userIdN
// A durable match exists, so this applies from any status.
const ACCEPTED_SCRIPT = `
local raw = redis.call('get', KEYS[1])
if not raw then return 'CHALLENGE_NOT_FOUND' end
local record = cjson.decode(raw)
if record.status == 'ACCEPTED' then return 'ALREADY_ACCEPTED' end
record.status = 'ACCEPTED'
record.matchId = ARGV[2]
redis.call('set', KEYS[1], cjson.encode(record), 'EX', tonumber(ARGV[3]))
local n = tonumber(ARGV[4])
for i = 1, n do
  if redis.call('get', KEYS[3 + i]) == ARGV[1] then redis.call('del', KEYS[3 + i]) end
  redis.call('del', KEYS[3 + n + i])
  redis.call('zrem', KEYS[2], ARGV[4 + i])
end
redis.call('zrem', KEYS[3], ARGV[1])
return 'OK'`;

// KEYS: challenge expires inviteKey res...
// ARGV: recordJson id expiresAtMs ttl hasInvite
const RESERVE_DIRECT_SCRIPT = `
for i = 4, #KEYS do
  if redis.call('exists', KEYS[i]) == 1 then return 'CHALLENGE_ALREADY_PENDING' end
end
local ttl = tonumber(ARGV[4])
if ARGV[5] == '1' then
  if not redis.call('set', KEYS[3], ARGV[2], 'NX', 'EX', ttl) then return 'INVITE_CODE_TAKEN' end
end
for i = 4, #KEYS do redis.call('set', KEYS[i], ARGV[2], 'EX', ttl) end
redis.call('set', KEYS[1], ARGV[1], 'EX', ttl)
redis.call('zadd', KEYS[2], ARGV[3], ARGV[2])
return 'OK'`;

// KEYS: challenge resInviter resJoiner
// ARGV: id joinerId nowMs recordTtl
const CLAIM_INVITE_SCRIPT = `
local raw = redis.call('get', KEYS[1])
if not raw then return 'INVITE_NOT_FOUND' end
local record = cjson.decode(raw)
if record.status ~= 'PENDING' or record.opponentId ~= '' then return 'CHALLENGE_NOT_PENDING' end
if tonumber(record.expiresAtMs) <= tonumber(ARGV[3]) then return 'CHALLENGE_EXPIRED' end
if redis.call('get', KEYS[2]) ~= ARGV[1] then return 'CHALLENGE_NOT_PENDING' end
if redis.call('exists', KEYS[3]) == 1 then return 'CHALLENGE_ALREADY_PENDING' end
record.opponentId = ARGV[2]
record.status = 'ACCEPTING'
record.acceptingAtMs = tonumber(ARGV[3])
redis.call('set', KEYS[1], cjson.encode(record), 'EX', tonumber(ARGV[4]))
redis.call('set', KEYS[3], ARGV[1], 'EX', tonumber(ARGV[4]))
return 'OK'`;

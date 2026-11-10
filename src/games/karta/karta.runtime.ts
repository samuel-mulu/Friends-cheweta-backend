import { commitmentOf, rankOf, shuffledDeck } from './karta.deck';
import {
  KARTA_RANKS,
  KARTA_TARGET_SCORE,
  KARTA_V1,
  KartaEventType,
  KartaGameState,
  KartaMatchRuntimeState,
  KartaRank,
  KartaRuntimeCommand,
  KartaRuntimeEvent,
} from './karta.types';

/** Source of fresh secret seeds (crypto in production, fixed in tools). */
export type SeedSource = () => string;

const other = (game: KartaGameState, userId: string): string => game.players.find((p) => p.userId !== userId)!.userId;

/** Round state for [starterId]: the other player chooses; a fresh deck is sealed. */
function newRound(game: KartaGameState, round: number, starterId: string, seed: string): KartaGameState {
  const callerId = other(game, starterId);
  return {
    ...game,
    round,
    starterId,
    callerId,
    calledRank: null,
    roundPhase: 'CALLING',
    currentPlayerId: callerId,
    receiverId: null,
    dealt: [],
    deckCommitment: commitmentOf(seed),
  };
}

/** A new match; [firstStarterId] deals round 1 (the other player chooses). */
export function createKartaMatch(
  matchId: string,
  playerIds: [string, string],
  firstStarterId: string,
  newSeed: SeedSource,
): KartaMatchRuntimeState {
  const seed = newSeed();
  const base: KartaGameState = {
    matchId,
    rulesVersion: KARTA_V1,
    version: 0,
    phase: 'PLAYING',
    players: playerIds.map((userId) => ({ userId })),
    targetScore: KARTA_TARGET_SCORE,
    scores: Object.fromEntries(playerIds.map((id) => [id, 0])),
    round: 1,
    starterId: firstStarterId,
    callerId: firstStarterId,
    calledRank: null,
    roundPhase: 'CALLING',
    currentPlayerId: null,
    receiverId: null,
    dealt: [],
    deckCommitment: '',
    lastRound: null,
    winnerOrder: [],
    result: null,
    finishReason: null,
  };
  return { game: newRound(base, 1, firstStarterId, seed), secret: { seed } };
}

/** What a player may see: the secret seed stays on the server until revealed. */
export const publicKartaState = (state: KartaMatchRuntimeState) => ({ game: state.game });

export const isKartaRank = (value: string): value is KartaRank => (KARTA_RANKS as readonly string[]).includes(value);

/** Pure apart from [newSeed] (used when the next round starts). */
export function executeKartaCommand(
  state: KartaMatchRuntimeState,
  command: KartaRuntimeCommand,
  newSeed: SeedSource,
): { state: KartaMatchRuntimeState; events: KartaRuntimeEvent[] } {
  if (!command.commandId.trim()) throw new Error('COMMAND_ID_REQUIRED');
  const game = state.game;
  if (game.phase !== 'PLAYING') throw new Error('MATCH_NOT_PLAYING');
  if (command.expectedVersion !== game.version) throw new Error('MATCH_VERSION_CONFLICT');
  if (!game.players.some((p) => p.userId === command.playerId)) throw new Error('PLAYER_NOT_IN_MATCH');

  const version = game.version + 1;
  const event = (type: KartaEventType, extra: Partial<KartaRuntimeEvent> = {}): KartaRuntimeEvent => ({
    type,
    matchId: game.matchId,
    version,
    ...extra,
  });

  // Resigning is allowed any time, by either player.
  if (command.type === 'RESIGN') {
    const winnerOrder = [other(game, command.playerId), command.playerId];
    return {
      state: {
        ...state,
        game: { ...game, version, phase: 'FINISHED', currentPlayerId: null, receiverId: null, winnerOrder, result: 'WIN', finishReason: 'RESIGN' },
      },
      events: [
        event(KartaEventType.PLAYER_RESIGNED, { playerId: command.playerId }),
        event(KartaEventType.MATCH_FINISHED, { winnerOrder, reason: 'RESIGN' }),
      ],
    };
  }

  if (game.currentPlayerId !== command.playerId) throw new Error('NOT_PLAYER_TURN');

  if (command.type === 'CALL') {
    if (game.roundPhase !== 'CALLING') throw new Error('INVALID_TURN_PHASE');
    if (!isKartaRank(command.rank)) throw new Error('INVALID_RANK');
    // Now only the starter acts; the first card goes to the chooser ("for away").
    return {
      state: {
        ...state,
        game: { ...game, version, calledRank: command.rank, roundPhase: 'FLIPPING', currentPlayerId: game.starterId, receiverId: game.callerId },
      },
      events: [event(KartaEventType.RANK_CALLED, { playerId: command.playerId, rank: command.rank, round: game.round })],
    };
  }

  // FLIP by the starter: the next card of the sealed deck goes to the receiver.
  if (game.roundPhase !== 'FLIPPING' || !game.calledRank || !game.receiverId) throw new Error('INVALID_TURN_PHASE');
  const receiverId = game.receiverId;
  const index = game.dealt.length;
  const card = shuffledDeck(state.secret.seed)[index];
  const dealt = [...game.dealt, { card, playerId: receiverId }];
  const events = [event(KartaEventType.CARD_FLIPPED, { playerId: receiverId, card, index, round: game.round })];

  if (rankOf(card) !== game.calledRank) {
    // Alternate: for away, for me… Every rank appears 4 times, so a round always ends.
    return { state: { ...state, game: { ...game, version, dealt, receiverId: other(game, receiverId) } }, events };
  }

  const scores = { ...game.scores, [receiverId]: (game.scores[receiverId] ?? 0) + 1 };
  const result = { round: game.round, winnerId: receiverId, rank: game.calledRank, card, flips: dealt.length, seed: state.secret.seed };
  events.push(event(KartaEventType.ROUND_WON, { playerId: receiverId, rank: game.calledRank, card, scores, result }));

  if (scores[receiverId] >= game.targetScore) {
    const winnerOrder = [receiverId, other(game, receiverId)];
    events.push(event(KartaEventType.MATCH_FINISHED, { winnerOrder, reason: 'SCORE', scores }));
    return {
      state: {
        ...state,
        game: {
          ...game,
          version,
          dealt,
          scores,
          lastRound: result,
          phase: 'FINISHED',
          currentPlayerId: null,
          receiverId: null,
          winnerOrder,
          result: 'WIN',
          finishReason: 'SCORE',
        },
      },
      events,
    };
  }

  // The round winner starts the next round; the loser chooses.
  const seed = newSeed();
  const next = newRound({ ...game, version, scores, lastRound: result }, game.round + 1, receiverId, seed);
  events.push(
    event(KartaEventType.ROUND_STARTED, {
      round: next.round,
      starterId: next.starterId,
      callerId: next.callerId,
      deckCommitment: next.deckCommitment,
      scores,
    }),
  );
  return { state: { game: next, secret: { seed } }, events };
}

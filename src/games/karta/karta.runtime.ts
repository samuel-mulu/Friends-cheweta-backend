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

/** A new match: [firstCallerId] calls the first rank. */
export function createKartaMatch(
  matchId: string,
  playerIds: [string, string],
  firstCallerId: string,
  newSeed: SeedSource,
): KartaMatchRuntimeState {
  const seed = newSeed();
  return {
    game: {
      matchId,
      rulesVersion: KARTA_V1,
      version: 0,
      phase: 'PLAYING',
      players: playerIds.map((userId) => ({ userId })),
      targetScore: KARTA_TARGET_SCORE,
      scores: Object.fromEntries(playerIds.map((id) => [id, 0])),
      round: 1,
      callerId: firstCallerId,
      calledRank: null,
      roundPhase: 'CALLING',
      currentPlayerId: firstCallerId,
      dealt: [],
      deckCommitment: commitmentOf(seed),
      lastRound: null,
      winnerOrder: [],
      result: null,
      finishReason: null,
    },
    secret: { seed },
  };
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

  if (command.type === 'RESIGN') {
    const winnerId = other(game, command.playerId);
    const winnerOrder = [winnerId, command.playerId];
    return {
      state: {
        ...state,
        game: { ...game, version, phase: 'FINISHED', currentPlayerId: null, winnerOrder, result: 'WIN', finishReason: 'RESIGN' },
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
    // The other player receives the first card.
    const receiver = other(game, command.playerId);
    return {
      state: { ...state, game: { ...game, version, calledRank: command.rank, roundPhase: 'FLIPPING', currentPlayerId: receiver } },
      events: [event(KartaEventType.RANK_CALLED, { playerId: command.playerId, rank: command.rank, round: game.round })],
    };
  }

  // FLIP: the next card of the committed deck goes to the current player.
  if (game.roundPhase !== 'FLIPPING' || !game.calledRank) throw new Error('INVALID_TURN_PHASE');
  const deck = shuffledDeck(state.secret.seed);
  const index = game.dealt.length;
  const card = deck[index];
  const dealt = [...game.dealt, { card, playerId: command.playerId }];
  const events = [event(KartaEventType.CARD_FLIPPED, { playerId: command.playerId, card, index, round: game.round })];

  if (rankOf(card) !== game.calledRank) {
    // Every rank appears 4 times in 52 cards, so a round always ends.
    return {
      state: { ...state, game: { ...game, version, dealt, currentPlayerId: other(game, command.playerId) } },
      events,
    };
  }

  const scores = { ...game.scores, [command.playerId]: (game.scores[command.playerId] ?? 0) + 1 };
  const result = {
    round: game.round,
    winnerId: command.playerId,
    rank: game.calledRank,
    card,
    flips: dealt.length,
    seed: state.secret.seed,
  };
  events.push(event(KartaEventType.ROUND_WON, { playerId: command.playerId, rank: game.calledRank, card, scores, result }));

  if (scores[command.playerId] >= game.targetScore) {
    const winnerOrder = [command.playerId, other(game, command.playerId)];
    events.push(event(KartaEventType.MATCH_FINISHED, { winnerOrder, reason: 'SCORE', scores }));
    return {
      state: {
        ...state,
        game: { ...game, version, dealt, scores, lastRound: result, phase: 'FINISHED', currentPlayerId: null, winnerOrder, result: 'WIN', finishReason: 'SCORE' },
      },
      events,
    };
  }

  // Next round: the other player calls, over a freshly committed deck.
  const seed = newSeed();
  const callerId = other(game, game.callerId);
  const next: KartaGameState = {
    ...game,
    version,
    scores,
    lastRound: result,
    round: game.round + 1,
    callerId,
    calledRank: null,
    roundPhase: 'CALLING',
    currentPlayerId: callerId,
    dealt: [],
    deckCommitment: commitmentOf(seed),
  };
  events.push(event(KartaEventType.ROUND_STARTED, { round: next.round, callerId, deckCommitment: next.deckCommitment, scores }));
  return { state: { game: next, secret: { seed } }, events };
}

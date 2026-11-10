/**
 * ካርታ ላጥ ላጥ — Karta Lat Lat, rules version KARTA_LATLAT_V1.
 *
 * 1v1, one standard 52-card deck (no jokers). Each round has a starter (the
 * dealer) and a chooser (the other player). The server shuffles and
 * publishes a commitment (SHA-256 of the secret seed) *before* the call. The
 * chooser names a rank (suits do not matter); then only the starter acts,
 * turning ("lat") the cards one by one: the first to the chooser ("for
 * away"), the next to themselves ("for me"), and so on. Whoever receives the
 * first card of the called rank wins the round and starts the next one; the
 * loser chooses. Round 1's starter is drawn at random. First to
 * [KARTA_TARGET_SCORE] rounds wins the match. After each round the seed is
 * revealed so anyone can re-derive the deck and verify it.
 */
export const KARTA_V1 = 'KARTA_LATLAT_V1' as const;
export type KartaRulesVersion = typeof KARTA_V1;
export const isKartaRulesVersion = (value: string): value is KartaRulesVersion => value === KARTA_V1;

export const KARTA_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;
export const KARTA_SUITS = ['S', 'H', 'D', 'C'] as const;
export type KartaRank = (typeof KARTA_RANKS)[number];
export type KartaSuit = (typeof KARTA_SUITS)[number];
/** Rank then suit, e.g. `10H`, `QS`. */
export type KartaCard = string;

export const KARTA_TARGET_SCORE = 3;

export type KartaRoundPhase = 'CALLING' | 'FLIPPING';

export type KartaDealt = { card: KartaCard; playerId: string };

export type KartaRoundResult = {
  round: number;
  winnerId: string;
  rank: KartaRank;
  card: KartaCard;
  flips: number;
  /** Revealed secret: SHA-256(seed) equals the round's commitment. */
  seed: string;
};

/** Public game state (safe to send to players). */
export type KartaGameState = {
  matchId: string;
  rulesVersion: KartaRulesVersion;
  version: number;
  phase: 'PLAYING' | 'FINISHED';
  players: Array<{ userId: string }>;
  targetScore: number;
  scores: Record<string, number>;
  round: number;
  /** Deals (turns every card) this round; the previous round's winner. */
  starterId: string;
  /** Names the rank this round (the other player). */
  callerId: string;
  calledRank: KartaRank | null;
  roundPhase: KartaRoundPhase;
  /** Who must act: the chooser while CALLING, the starter while FLIPPING. */
  currentPlayerId: string | null;
  /** Who gets the next card turned (FLIPPING). */
  receiverId: string | null;
  /** Cards turned this round, in order. */
  dealt: KartaDealt[];
  /** SHA-256 of this round's secret seed (published before the call). */
  deckCommitment: string;
  lastRound: KartaRoundResult | null;
  winnerOrder: string[];
  result: 'WIN' | null;
  finishReason: 'SCORE' | 'RESIGN' | null;
};

/** Server-side state: the public game plus the secret that orders the deck. */
export type KartaMatchRuntimeState = {
  game: KartaGameState;
  secret: { seed: string };
};

export enum KartaEventType {
  ROUND_STARTED = 'ROUND_STARTED',
  RANK_CALLED = 'RANK_CALLED',
  CARD_FLIPPED = 'CARD_FLIPPED',
  ROUND_WON = 'ROUND_WON',
  PLAYER_RESIGNED = 'PLAYER_RESIGNED',
  MATCH_FINISHED = 'MATCH_FINISHED',
}

export type KartaRuntimeEvent = {
  type: KartaEventType;
  matchId: string;
  version: number;
  playerId?: string;
  round?: number;
  starterId?: string;
  callerId?: string;
  deckCommitment?: string;
  rank?: KartaRank;
  card?: KartaCard;
  index?: number;
  scores?: Record<string, number>;
  result?: KartaRoundResult;
  winnerOrder?: string[];
  reason?: 'SCORE' | 'RESIGN';
};

type Base = { commandId: string; playerId: string; expectedVersion: number };
export type KartaRuntimeCommand =
  | (Base & { type: 'CALL'; rank: KartaRank })
  | (Base & { type: 'FLIP' })
  | (Base & { type: 'RESIGN' });

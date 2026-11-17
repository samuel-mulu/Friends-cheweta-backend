/**
 * What a turn-based game (Ludo, Dama, Karta…) must provide so the shared
 * realtime machinery can run it: Redis snapshot + idempotent commands under a
 * lock, ordered persistence, settlement, a per-turn clock with strikes, and a
 * socket gateway. Everything game-specific lives in the definition; the
 * runtime, timer and gateway are written once.
 */
export type TurnGameState = {
  game: {
    matchId: string;
    version: number;
    players: Array<{ userId: string }>;
    currentPlayerId: string | null;
    winnerOrder: string[];
    /** Set by games that can end in a draw (Dama). */
    result?: 'WIN' | 'DRAW' | null;
  };
};

export type TurnGameEvent = { type: string; matchId: string; version: number };

export type TurnGameCommand = { type: string; commandId: string; playerId: string; expectedVersion: number };

/** A command without its envelope (id, player, version), e.g. `{ type: 'FLIP' }`. */
export type CommandBody<C> = C extends unknown ? Omit<C, 'commandId' | 'playerId' | 'expectedVersion'> : never;

/** Per-match options chosen at creation (from the `Match` row). */
export type TurnGameCreateOptions = {
  /** Ludo "first to N home"; ignored by games without the notion. */
  tokensToWin?: number;
};

export interface TurnGameDefinition<S extends TurnGameState, C extends TurnGameCommand, E extends TurnGameEvent> {
  /** Backend game code (`Game.code`), e.g. `DAMA`. */
  readonly code: string;
  /** Redis namespace and socket event prefix, e.g. `dama`. */
  readonly key: string;
  /** Domain event type → socket event name. */
  readonly eventNames: Record<string, string>;
  readonly defaultTurnSeconds: number;
  /** Seats a match may have (default 2–2). */
  readonly minPlayers?: number;
  readonly maxPlayers?: number;

  isRulesVersion(value: string): boolean;
  /** A new match for these players (seat order); may use randomness. */
  create(matchId: string, playerIds: string[], rulesVersion: string, options: TurnGameCreateOptions): S;
  /** Validate and apply; throws `Error('CODE')` when the command is not allowed. */
  execute(state: S, command: C): { state: S; events: E[] };
  isFinished(state: S): boolean;
  /**
   * True before play has started (e.g. Ludo's starting roll). While pre-game
   * the match may still be cancelled and refunded, and a timeout auto-plays for
   * every pending player without counting a strike.
   */
  isPreGame?(state: S): boolean;
  /** Players who must act now; default: the current player. */
  actingPlayers?(state: S): string[];
  /** Commands allowed only once every participant has opened the match. */
  requiresAllJoined?(command: CommandBody<C>): boolean;
  /** The command played for a player whose clock ran out, or null when nothing can be played. */
  autoCommand(state: S, playerId: string): CommandBody<C> | null;
  resignCommand(): CommandBody<C>;
  /** Whether this player may still resign (default: while the match is not finished). */
  canResign?(state: S, userId: string): boolean;
  /** Game-specific turn phase for the timing payload (null when the game has none). */
  turnPhase?(state: S): string | null;
  /** What clients may see (hide secrets such as the order of a card deck). */
  publicState(state: S): unknown;
  /** Extra per-player fields for the participant list (e.g. piece colour). */
  playerInfo?(state: S, userId: string): Record<string, unknown>;
  /** Extra fields on join/sync acks (legal moves, board geometry…). */
  snapshotExtras?(state: S): Record<string, unknown>;
}

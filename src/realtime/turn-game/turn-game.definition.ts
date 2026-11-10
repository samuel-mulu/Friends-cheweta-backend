/**
 * What a simple turn-based 1v1 game (Dama, Karta…) must provide so the shared
 * realtime machinery can run it: Redis snapshot + idempotent commands under a
 * lock, ordered persistence, settlement, a per-turn clock with strikes, and a
 * socket gateway. Ludo predates this and keeps its own runtime.
 */
export type TurnGameState = {
  game: {
    matchId: string;
    version: number;
    players: Array<{ userId: string }>;
    currentPlayerId: string | null;
    winnerOrder: string[];
    result: 'WIN' | 'DRAW' | null;
  };
};

export type TurnGameEvent = { type: string; matchId: string; version: number };

export type TurnGameCommand = { type: string; commandId: string; playerId: string; expectedVersion: number };

/** A command without its envelope (id, player, version), e.g. `{ type: 'FLIP' }`. */
export type CommandBody<C> = C extends unknown ? Omit<C, 'commandId' | 'playerId' | 'expectedVersion'> : never;

export interface TurnGameDefinition<S extends TurnGameState, C extends TurnGameCommand, E extends TurnGameEvent> {
  /** Backend game code (`Game.code`), e.g. `DAMA`. */
  readonly code: string;
  /** Redis namespace and socket event prefix, e.g. `dama`. */
  readonly key: string;
  /** Domain event type → socket event name. */
  readonly eventNames: Record<string, string>;
  readonly defaultTurnSeconds: number;

  isRulesVersion(value: string): boolean;
  /** A new match for these players (seat order); may use randomness. */
  create(matchId: string, playerIds: string[], rulesVersion: string): S;
  /** Validate and apply; throws `Error('CODE')` when the command is not allowed. */
  execute(state: S, command: C): { state: S; events: E[] };
  isFinished(state: S): boolean;
  /** The command played for a player whose clock ran out (not a resignation). */
  autoCommand(state: S, playerId: string): CommandBody<C>;
  resignCommand(): CommandBody<C>;
  /** What clients may see (hide secrets such as the order of a card deck). */
  publicState(state: S): unknown;
  /** Extra per-player fields for the participant list (e.g. piece colour). */
  playerInfo?(state: S, userId: string): Record<string, unknown>;
}

import { TurnGameDefinition } from './turn-game.definition';
import { TurnGameRuntime } from './turn-game-runtime';
import { TurnGameTimer } from './turn-game-timer';

// `any` on purpose: a registry entry is used only through the game-agnostic
// methods (processDue, discard, allJoined, forfeitAbsent, retryPostCommit).
export type AnyTurnGameDefinition = TurnGameDefinition<any, any, any>;
export type AnyTurnGameRuntime = TurnGameRuntime<any, any, any>;
export type AnyTurnGameTimer = TurnGameTimer<any, any, any>;

export type RegisteredGame = {
  definition: AnyTurnGameDefinition;
  runtime: AnyTurnGameRuntime;
  timer: AnyTurnGameTimer;
};

/**
 * Every live game the server runs, by `Game.code`. Cross-game services
 * (maintenance ticks, disconnect grace, pre-match cleanup) loop over this
 * instead of naming each game.
 */
export class GameRegistry {
  private readonly byCode = new Map<string, RegisteredGame>();

  constructor(games: RegisteredGame[]) {
    for (const game of games) this.byCode.set(game.definition.code, game);
  }

  all(): RegisteredGame[] {
    return [...this.byCode.values()];
  }

  get(code: string): RegisteredGame | undefined {
    return this.byCode.get(code);
  }
}

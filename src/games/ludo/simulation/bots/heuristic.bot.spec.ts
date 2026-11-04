import {
  LudoMatchPhase,
  LudoTokenState,
  LudoTurnPhase,
  createInitialLudoState,
} from '../../domain';
import { LudoEngine } from '../../engine';
import { HeuristicBot } from './heuristic.bot';

/** RED = p1 (start 0), YELLOW = p2 (start 26). */
function state(red: number[], yellow: number[]) {
  const game = createInitialLudoState('m', ['p1', 'p2'], 'LUDO_CLASSIC_V2');
  game.phase = LudoMatchPhase.PLAYING;
  game.turnPhase = LudoTurnPhase.WAITING_FOR_MOVE;
  game.currentPlayerId = 'p1';
  const place = (i: number, progress: number[]) =>
    game.players[i].tokens.forEach((t, k) => {
      const p = progress[k] ?? -1;
      t.progress = p;
      t.state =
        p < 0
          ? LudoTokenState.BASE
          : p >= 57
            ? LudoTokenState.FINISHED
            : p >= 52
              ? LudoTokenState.HOME_PATH
              : LudoTokenState.ACTIVE;
    });
  place(0, red);
  place(1, yellow);
  return game;
}

const choose = (game: ReturnType<typeof state>, dice: number) =>
  new HeuristicBot(1).chooseMove(game, 'p1', dice, new LudoEngine().getLegalMoves(game, 'p1', dice))
    .tokenId;

describe('HeuristicBot (Hard practice)', () => {
  it('takes a capture over a plain move', () => {
    // RED-2 at 10 +2 lands on yellow at global 12; RED-1 at 30 would just advance.
    expect(choose(state([30, 10], [38]), 2)).toBe('RED-2');
  });

  it('escapes a threatened token instead of advancing a safe one', () => {
    // Yellow at global 2 (progress 28) threatens RED-1 at global 5. RED-1 +3 -> 8 (safe star).
    expect(choose(state([5, 20], [28]), 3)).toBe('RED-1');
  });

  it('brings a token home when it can', () => {
    expect(choose(state([54, 20], []), 3)).toBe('RED-1');
  });
});

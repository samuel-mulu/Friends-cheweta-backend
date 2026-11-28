import { createInitialLudoState, tokensToWinOf } from '../domain';
import { assertValidLudoState } from '../domain/ludo.invariants';
import { LudoTokenState } from '../domain/ludo.types';
import { MixedBot, RandomBot } from './bots';
import { replayLudoSimulation, simulateLudoMatch } from './ludo.simulator';

describe('first to N home (tokensToWin)', () => {
  it('accepts 1 to 4 and rejects anything else', () => {
    for (const goal of [1, 2, 3, 4]) {
      expect(
        createInitialLudoState('m', ['a', 'b'], undefined, { tokensToWin: goal }).tokensToWin,
      ).toBe(goal);
    }
    for (const bad of [0, 5, 2.5]) {
      expect(() =>
        createInitialLudoState('m', ['a', 'b'], undefined, { tokensToWin: bad }),
      ).toThrow(RangeError);
    }
  });

  it('old states without the field still need all four tokens home', () => {
    const state = createInitialLudoState('m', ['a', 'b']);
    delete state.tokensToWin;
    expect(() => assertValidLudoState(state)).not.toThrow();
    expect(tokensToWinOf(state)).toBe(4);
  });

  it.each([1, 2, 3, 4])('a game to %i ends as soon as the winner has that many home', (goal) => {
    for (let index = 0; index < 8; index += 1) {
      const result = simulateLudoMatch({
        matchId: `goal-${goal}-${index}`,
        playerIds: ['p1', 'p2', 'p3'],
        bots: {
          p1: new MixedBot(index + 1),
          p2: new RandomBot(index + 50),
          p3: new RandomBot(index + 90),
        },
        seed: `goal-dice-${goal}-${index}`,
        tokensToWin: goal,
        rulesVersion: (['LUDO_CLASSIC_V1', 'LUDO_CLASSIC_V2', 'LUDO_CLASSIC_V3'] as const)[
          index % 3
        ],
      });
      const home = (userId: string) =>
        result.finalState.players
          .find((player) => player.userId === userId)!
          .tokens.filter((token) => token.state === LudoTokenState.FINISHED).length;
      // 3 players: the match ends at the first winner, who reached exactly the
      // goal; everyone else is still short of it.
      const [winner, ...rest] = result.winnerOrder;
      expect(home(winner)).toBe(goal);
      for (const playerId of rest) expect(home(playerId)).toBeLessThan(goal);
      // The winner is out: no token left on the shared track to block anyone;
      // tokens already in the private home lane stay where they are.
      const onTrack = (userId: string) =>
        result.finalState.players
          .find((player) => player.userId === userId)!
          .tokens.filter((token) => token.state === LudoTokenState.ACTIVE);
      expect(onTrack(winner)).toEqual([]);
      replayLudoSimulation(result);
    }
  });
});

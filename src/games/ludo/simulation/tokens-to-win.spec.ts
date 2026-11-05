import { createInitialLudoState, tokensToWinOf } from '../domain';
import { assertValidLudoState } from '../domain/ludo.invariants';
import { LudoTokenState } from '../domain/ludo.types';
import { MixedBot, RandomBot } from './bots';
import { replayLudoSimulation, simulateLudoMatch } from './ludo.simulator';

describe('first to N home (tokensToWin)', () => {
  it('accepts 1 to 4 and rejects anything else', () => {
    for (const goal of [1, 2, 3, 4]) {
      expect(createInitialLudoState('m', ['a', 'b'], undefined, { tokensToWin: goal }).tokensToWin).toBe(goal);
    }
    for (const bad of [0, 5, 2.5]) {
      expect(() => createInitialLudoState('m', ['a', 'b'], undefined, { tokensToWin: bad })).toThrow(RangeError);
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
        bots: { p1: new MixedBot(index + 1), p2: new RandomBot(index + 50), p3: new RandomBot(index + 90) },
        seed: `goal-dice-${goal}-${index}`,
        tokensToWin: goal,
        rulesVersion: index % 2 === 0 ? 'LUDO_CLASSIC_V1' : 'LUDO_CLASSIC_V2',
      });
      const home = (userId: string) =>
        result.finalState.players
          .find((player) => player.userId === userId)!
          .tokens.filter((token) => token.state === LudoTokenState.FINISHED).length;
      // Everyone who finished on the board reached exactly the goal (the last
      // player is ranked by elimination and stays short of it).
      for (const playerId of result.winnerOrder.slice(0, -1)) expect(home(playerId)).toBe(goal);
      // A player who is out leaves no token on the track to block the others.
      const onTrack = (userId: string) =>
        result.finalState.players
          .find((player) => player.userId === userId)!
          .tokens.filter((token) => token.state !== LudoTokenState.FINISHED && token.state !== LudoTokenState.BASE);
      for (const playerId of result.winnerOrder.slice(0, -1)) expect(onTrack(playerId)).toEqual([]);
      expect(home(result.winnerOrder.at(-1)!)).toBeLessThan(goal);
      replayLudoSimulation(result);
    }
  });
});

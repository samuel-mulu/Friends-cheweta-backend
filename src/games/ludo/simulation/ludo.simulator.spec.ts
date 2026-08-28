import { AggressiveBot, DefensiveBot, FastBot, MixedBot, RandomBot } from './bots';
import { replayLudoSimulation, simulateLudoMatch } from './ludo.simulator';

describe('Ludo simulation', () => {
  it('completes and exactly replays deterministic matches', () => {
    for (let index = 0; index < 20; index += 1) {
      const result = simulateLudoMatch({
        matchId: `replay-${index}`,
        playerIds: ['p1', 'p2'],
        bots: {
          p1: new MixedBot(index + 1),
          p2: new RandomBot(index + 101),
        },
        seed: `dice-${index}`,
      });
      expect(result.winnerOrder).toHaveLength(2);
      replayLudoSimulation(result);
    }
  });

  it('fuzzes strategy combinations without violating engine invariants', () => {
    const factories = [
      (seed: number) => new RandomBot(seed),
      (seed: number) => new DefensiveBot(seed),
      (seed: number) => new AggressiveBot(seed),
      (seed: number) => new FastBot(seed),
      (seed: number) => new MixedBot(seed),
    ];

    for (let index = 0; index < 50; index += 1) {
      const first = factories[index % factories.length];
      const second = factories[(index * 3 + 1) % factories.length];
      const result = simulateLudoMatch({
        matchId: `fuzz-${index}`,
        playerIds: ['p1', 'p2'],
        bots: { p1: first(index + 7), p2: second(index + 700) },
        seed: `fuzz-dice-${index}`,
      });
      expect(new Set(result.winnerOrder).size).toBe(2);
      expect(result.commandsExecuted).toBeGreaterThan(0);
    }
  });
});

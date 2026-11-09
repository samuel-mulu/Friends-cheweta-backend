import { MinimaxDamaBot, RandomDamaBot } from './dama.bots';
import { simulateDamaMatch } from './dama.simulator';

describe('Dama simulation', () => {
  it('random games always end legally (invariants checked every ply)', () => {
    for (let index = 0; index < 150; index += 1) {
      const result = simulateDamaMatch({
        matchId: `sim-${index}`,
        light: { userId: 'p1', bot: new RandomDamaBot(index * 2 + 1) },
        dark: { userId: 'p2', bot: new RandomDamaBot(index * 2 + 2) },
      });
      expect(['WIN', 'DRAW']).toContain(result.result);
    }
  });

  it('is deterministic for the same seeds', () => {
    const play = () =>
      simulateDamaMatch({
        matchId: 'same',
        light: { userId: 'p1', bot: new RandomDamaBot(7) },
        dark: { userId: 'p2', bot: new MinimaxDamaBot(1, 8) },
      });
    expect(play().state).toEqual(play().state);
  });

  it('a searching bot clearly beats a random one', () => {
    let wins = 0;
    for (let index = 0; index < 12; index += 1) {
      const searchIsLight = index % 2 === 0;
      const search = { userId: 'search', bot: new MinimaxDamaBot(2, index + 1) };
      const random = { userId: 'random', bot: new RandomDamaBot(index + 100) };
      const result = simulateDamaMatch({
        matchId: `vs-${index}`,
        light: searchIsLight ? search : random,
        dark: searchIsLight ? random : search,
      });
      if (result.winnerOrder[0] === 'search') wins += 1;
    }
    expect(wins).toBeGreaterThanOrEqual(10);
  });
});

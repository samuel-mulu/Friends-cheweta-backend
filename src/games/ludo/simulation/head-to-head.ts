/**
 * Bot difficulty check: each pair plays N games with seats swapped every game
 * (cancels first-move advantage). Prints how often the first bot wins.
 *   npm run bots:ludo -- 2000 LUDO_CLASSIC_V2
 */
import { isLudoRulesVersion } from '../domain';
import { AggressiveBot, FastBot, HeuristicBot, LudoBot, MixedBot, RandomBot } from './bots';
import { simulateLudoMatch } from './ludo.simulator';

const games = Number.parseInt(process.argv[2] ?? '2000', 10);
const rulesVersion = process.argv[3] ?? 'LUDO_CLASSIC_V2';
if (!isLudoRulesVersion(rulesVersion)) throw new Error(`Unknown rules version ${rulesVersion}`);

const make: Record<string, (seed: number) => LudoBot> = {
  RANDOM: (s) => new RandomBot(s),
  FAST: (s) => new FastBot(s),
  AGGRESSIVE: (s) => new AggressiveBot(s),
  MIXED: (s) => new MixedBot(s),
  HEURISTIC: (s) => new HeuristicBot(s),
};

const pairs: Array<[string, string]> = [
  ['FAST', 'RANDOM'],
  ['AGGRESSIVE', 'RANDOM'],
  ['MIXED', 'RANDOM'],
  ['HEURISTIC', 'RANDOM'],
  ['HEURISTIC', 'AGGRESSIVE'],
  ['HEURISTIC', 'MIXED'],
];

const report: Record<string, number> = {};
for (const [a, b] of pairs) {
  let aWins = 0;
  for (let i = 0; i < games; i += 1) {
    const aFirst = i % 2 === 0;
    const seats = aFirst ? ['A', 'B'] : ['B', 'A'];
    const result = simulateLudoMatch({
      matchId: `h2h-${a}-${b}-${i}`,
      playerIds: seats,
      bots: { A: make[a](i + 1), B: make[b](i + 50_001) },
      seed: `h2h-dice-${a}-${b}-${i}`,
      rulesVersion,
    });
    if (result.winnerOrder[0] === 'A') aWins += 1;
  }
  report[`${a} vs ${b}`] = Number((aWins / games).toFixed(3));
}
console.log(JSON.stringify({ games, rulesVersion, firstBotWinRate: report }, null, 2));

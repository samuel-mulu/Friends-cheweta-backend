import { AggressiveBot, DefensiveBot, FastBot, LudoBot, MixedBot, RandomBot } from './bots';
import { replayLudoSimulation, simulateLudoMatch } from './ludo.simulator';

type BotFactory = (seed: number) => LudoBot;

const factories: Array<{ name: string; make: BotFactory }> = [
  { name: 'RANDOM', make: (seed) => new RandomBot(seed) },
  { name: 'DEFENSIVE', make: (seed) => new DefensiveBot(seed) },
  { name: 'AGGRESSIVE', make: (seed) => new AggressiveBot(seed) },
  { name: 'FAST', make: (seed) => new FastBot(seed) },
  { name: 'MIXED', make: (seed) => new MixedBot(seed) },
];

const count = Number.parseInt(process.argv[2] ?? '5000', 10);
if (!Number.isInteger(count) || count <= 0) throw new Error('Game count must be a positive integer.');

const wins: Record<string, number> = {};
let totalCommands = 0;
let replayed = 0;

for (let index = 0; index < count; index += 1) {
  const left = factories[index % factories.length];
  const right = factories[(index * 7 + 3) % factories.length];
  const p1 = `p1-${left.name}`;
  const p2 = `p2-${right.name}`;
  const result = simulateLudoMatch({
    matchId: `bulk-${index}`,
    playerIds: [p1, p2],
    bots: {
      [p1]: left.make(index + 1),
      [p2]: right.make(index + 100_001),
    },
    seed: `bulk-dice-${index}`,
  });

  const winnerStrategy = result.winnerOrder[0].split('-').slice(1).join('-');
  wins[winnerStrategy] = (wins[winnerStrategy] ?? 0) + 1;
  totalCommands += result.commandsExecuted;

  // Replay a sample continuously so deterministic replay is exercised without
  // doubling the cost of every bulk simulation.
  if (index < Math.min(100, count)) {
    replayLudoSimulation(result);
    replayed += 1;
  }
}

console.log(JSON.stringify({
  games: count,
  replayed,
  averageCommands: Math.round(totalCommands / count),
  wins,
}, null, 2));

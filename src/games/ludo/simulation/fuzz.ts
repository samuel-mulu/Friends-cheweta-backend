import { AggressiveBot, DefensiveBot, FastBot, LudoBot, MixedBot, RandomBot } from './bots';
import { replayLudoSimulation, simulateLudoMatch } from './ludo.simulator';

type Factory = (seed: number) => LudoBot;
const factories: Factory[] = [
  (seed) => new RandomBot(seed),
  (seed) => new DefensiveBot(seed),
  (seed) => new AggressiveBot(seed),
  (seed) => new FastBot(seed),
  (seed) => new MixedBot(seed),
];

const count = Number.parseInt(process.argv[2] ?? '1000', 10);
if (!Number.isInteger(count) || count <= 0) throw new Error('Game count must be a positive integer.');

let totalCommands = 0;
const byPlayerCount: Record<number, number> = {};
for (let index = 0; index < count; index += 1) {
  const playerCount = 2 + (index % 3);
  const playerIds = Array.from({ length: playerCount }, (_, seat) => `p${seat + 1}`);
  const bots: Record<string, LudoBot> = {};
  playerIds.forEach((playerId, seat) => {
    bots[playerId] = factories[(index + seat * 2) % factories.length](index * 100 + seat + 1);
  });

  const result = simulateLudoMatch({
    matchId: `fuzz-${playerCount}-${index}`,
    playerIds,
    bots,
    seed: `fuzz-dice-${playerCount}-${index}`,
    maxCommands: 50_000,
    // Alternate rule sets and goals so every combination stays fuzzed.
    rulesVersion: index % 2 === 0 ? 'LUDO_CLASSIC_V1' : 'LUDO_CLASSIC_V2',
    tokensToWin: 1 + (Math.floor(index / 6) % 4),
  });

  if (result.winnerOrder.length !== playerCount) throw new Error('FUZZ_INCOMPLETE_RANKING');
  if (new Set(result.winnerOrder).size !== playerCount) throw new Error('FUZZ_DUPLICATE_RANKING');
  if (index < Math.min(50, count)) replayLudoSimulation(result);

  byPlayerCount[playerCount] = (byPlayerCount[playerCount] ?? 0) + 1;
  totalCommands += result.commandsExecuted;
}

console.log(JSON.stringify({
  games: count,
  byPlayerCount,
  replayed: Math.min(50, count),
  averageCommands: Math.round(totalCommands / count),
  status: 'passed',
}, null, 2));

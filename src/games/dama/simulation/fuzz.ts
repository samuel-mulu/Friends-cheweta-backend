import { DAMA_RULES_VERSIONS } from '../domain';
import { MinimaxDamaBot, RandomDamaBot } from './dama.bots';
import { simulateDamaMatch } from './dama.simulator';

/**
 * `npm run fuzz:dama [count]`: random (and some shallow-search) games must all
 * end legally. Games alternate between the rules versions (ታንከኛ / እግረኛ).
 */
const count = Number.parseInt(process.argv[2] ?? '1000', 10);
if (!Number.isInteger(count) || count <= 0)
  throw new Error('Game count must be a positive integer.');

const reasons: Record<string, number> = {};
let plies = 0;
let longest = 0;
for (let index = 0; index < count; index += 1) {
  const searching = index % 10 === 0; // every 10th game uses a 1-ply bot for realistic endgames
  const rulesVersion = DAMA_RULES_VERSIONS[index % DAMA_RULES_VERSIONS.length];
  const result = simulateDamaMatch({
    matchId: `fuzz-${index}`,
    rulesVersion,
    light: {
      userId: 'p1',
      bot: searching ? new MinimaxDamaBot(1, index + 1) : new RandomDamaBot(index * 2 + 1),
    },
    dark: { userId: 'p2', bot: new RandomDamaBot(index * 2 + 2) },
  });
  const key = `${rulesVersion} ${result.result}:${result.reason}`;
  reasons[key] = (reasons[key] ?? 0) + 1;
  plies += result.plies;
  longest = Math.max(longest, result.plies);
}

console.log(
  `Dama fuzz: ${count} games ok, avg ${(plies / count).toFixed(1)} plies, longest ${longest}`,
);
console.log(reasons);

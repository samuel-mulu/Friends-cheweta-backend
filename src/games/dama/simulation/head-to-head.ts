import { DamaBot, MinimaxDamaBot, RandomDamaBot } from './dama.bots';
import { simulateDamaMatch } from './dama.simulator';

/** `npm run bots:dama [games]`: score of each practice level against the one below. */
type Factory = { name: string; make: (seed: number) => DamaBot };
const random: Factory = { name: 'EASY (random)', make: (seed) => new RandomDamaBot(seed) };
const normal: Factory = { name: 'NORMAL (minimax-2)', make: (seed) => new MinimaxDamaBot(2, seed) };
const hard: Factory = { name: 'HARD (minimax-4)', make: (seed) => new MinimaxDamaBot(4, seed) };

const games = Number.parseInt(process.argv[2] ?? '60', 10);

function score(a: Factory, b: Factory): void {
  let points = 0;
  const started = Date.now();
  for (let index = 0; index < games; index += 1) {
    const aIsLight = index % 2 === 0; // alternate colours: Light moves first
    const light = { userId: aIsLight ? 'a' : 'b', bot: (aIsLight ? a : b).make(index + 1) };
    const dark = { userId: aIsLight ? 'b' : 'a', bot: (aIsLight ? b : a).make(index + 1001) };
    const result = simulateDamaMatch({ matchId: `h2h-${index}`, light, dark });
    if (result.result === 'DRAW') points += 0.5;
    else if (result.winnerOrder[0] === 'a') points += 1;
  }
  const ms = (Date.now() - started) / games;
  console.log(`${a.name} vs ${b.name}: ${(points / games).toFixed(3)} (${ms.toFixed(0)} ms/game)`);
}

score(normal, random);
score(hard, normal);
score(hard, random);

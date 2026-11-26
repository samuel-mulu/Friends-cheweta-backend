import { isDamaRulesVersion } from '../games/dama/domain';
import { isLudoRulesVersion } from '../games/ludo/domain';
import { AggressiveBot, HeuristicBot, LudoBot, RandomBot } from '../games/ludo/simulation/bots';

export type PracticeLevel = 'EASY' | 'NORMAL' | 'HARD';
export const PRACTICE_LEVELS: readonly PracticeLevel[] = ['EASY', 'NORMAL', 'HARD'];

/** Match.source for practice games: free, excluded from stats, leaderboard and rematch. */
export const PRACTICE_SOURCE = 'PRACTICE' as const;
export const PRACTICE_RULES_VERSION = 'LUDO_CLASSIC_V3' as const;

export type PracticeGame = 'LUDO' | 'DAMA';
export const PRACTICE_GAMES: readonly PracticeGame[] = ['LUDO', 'DAMA'];

/** Which rules versions (game types) each practice game can be played with. */
const PRACTICE_RULES: Record<PracticeGame, (version: string) => boolean> = {
  LUDO: isLudoRulesVersion,
  DAMA: isDamaRulesVersion,
};

/** The requested type when it belongs to [game]; null otherwise (the caller's default applies). */
export function practiceRulesFor(game: PracticeGame, requested?: string): string | null {
  return requested && PRACTICE_RULES[game](requested) ? requested : null;
}

/** One bot account per level (created by prisma/seed.ts). */
export const PRACTICE_BOTS: Record<PracticeLevel, { fullName: string; phone: string }> = {
  EASY: { fullName: 'Bot Easy', phone: '0900000001' },
  NORMAL: { fullName: 'Bot Normal', phone: '0900000002' },
  HARD: { fullName: 'Bot Hard', phone: '0900000003' },
};

/**
 * Strategy per level, ranked by head-to-head simulation (npm run bots:ludo):
 * Heuristic beats Random ~86% and Aggressive ~81%; Aggressive beats Random ~67%.
 */
export function practiceBot(level: PracticeLevel, seed: number): LudoBot {
  switch (level) {
    case 'EASY':
      return new RandomBot(seed);
    case 'NORMAL':
      return new AggressiveBot(seed);
    case 'HARD':
      return new HeuristicBot(seed);
  }
}

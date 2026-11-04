/** Per-player numbers for one finished match, derived from its recorded events. */
export type PlayerMatchStatRow = {
  userId: string;
  position: number;
  won: boolean;
  rolls: number;
  sixes: number;
  captures: number;
  tokensLost: number;
  tokensHome: number;
};

type EventLike = { type: string; payload: unknown };

/**
 * Pure: `events` are the match's MatchEvent rows (payload = runtime event),
 * `colorByUser` maps each player to their token color (token ids are COLOR-n).
 */
export function computePlayerMatchStats(input: {
  playerIds: string[];
  winnerOrder: string[];
  colorByUser: Record<string, string>;
  events: EventLike[];
}): PlayerMatchStatRow[] {
  const ownerByColor = new Map(Object.entries(input.colorByUser).map(([userId, color]) => [color, userId]));
  const rows = new Map<string, PlayerMatchStatRow>(
    input.playerIds.map((userId) => {
      const index = input.winnerOrder.indexOf(userId);
      const position = index >= 0 ? index + 1 : input.playerIds.length;
      return [userId, { userId, position, won: position === 1, rolls: 0, sixes: 0, captures: 0, tokensLost: 0, tokensHome: 0 }];
    }),
  );

  for (const event of input.events) {
    const payload = (event.payload ?? {}) as { playerId?: string; diceValue?: number; tokenIds?: string[] };
    const actor = payload.playerId ? rows.get(payload.playerId) : undefined;
    switch (event.type) {
      case 'DICE_ROLLED':
        if (actor) {
          actor.rolls += 1;
          if (payload.diceValue === 6) actor.sixes += 1;
        }
        break;
      case 'TOKEN_CAPTURED':
        for (const tokenId of payload.tokenIds ?? []) {
          if (actor) actor.captures += 1;
          const victim = rows.get(ownerByColor.get(tokenId.split('-')[0]) ?? '');
          if (victim) victim.tokensLost += 1;
        }
        break;
      case 'TOKEN_FINISHED':
        if (actor) actor.tokensHome += 1;
        break;
    }
  }
  return [...rows.values()];
}

export type PlayerStatsSummary = {
  games: number;
  wins: number;
  winRate: number;
  currentStreak: number;
  bestStreak: number;
  rolls: number;
  sixes: number;
  sixRate: number;
  captures: number;
  tokensHome: number;
};

/** Pure: lifetime summary from a player's rows, oldest first. */
export function summarizePlayerStats(rows: Array<Pick<PlayerMatchStatRow, 'won' | 'rolls' | 'sixes' | 'captures' | 'tokensHome'>>): PlayerStatsSummary {
  let wins = 0;
  let run = 0;
  let bestStreak = 0;
  let rolls = 0;
  let sixes = 0;
  let captures = 0;
  let tokensHome = 0;
  for (const row of rows) {
    if (row.won) {
      wins += 1;
      run += 1;
      bestStreak = Math.max(bestStreak, run);
    } else {
      run = 0;
    }
    rolls += row.rolls;
    sixes += row.sixes;
    captures += row.captures;
    tokensHome += row.tokensHome;
  }
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    games: rows.length,
    wins,
    winRate: rows.length ? round(wins / rows.length) : 0,
    currentStreak: run,
    bestStreak,
    rolls,
    sixes,
    sixRate: rolls ? round(sixes / rolls) : 0,
    captures,
    tokensHome,
  };
}

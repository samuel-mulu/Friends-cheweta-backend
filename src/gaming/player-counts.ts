/**
 * Player counts per game: the one place that says which tables exist.
 *
 * - Ludo: 2, 3 or 4 players in one match (3–4 fill automatically).
 * - Karta: a 1v1 match, or a queue table of up to 4 seats (KARTA_TABLE_V1)
 *   whose every round is a 1v1 match.
 * - Dama: 1v1 only.
 */
export const PLAYER_COUNTS: Record<string, readonly number[]> = {
  LUDO: [2, 3, 4],
  KARTA: [2, 3, 4],
  DAMA: [2],
};

/** Karta queue table: winner stays as starter, every round pays at once. */
export const KARTA_TABLE_RULES = 'KARTA_TABLE_V1';

export function supportsPlayerCount(gameCode: string, playerCount: number): boolean {
  return PLAYER_COUNTS[gameCode]?.includes(playerCount) ?? false;
}

/** A Karta queue-table mode: `playerCount` is the table's seat limit, rounds are 1v1. */
export function isKartaTable(rulesVersion: string): boolean {
  return rulesVersion === KARTA_TABLE_RULES;
}

/** Players in one match of this mode. */
export function playersPerMatch(mode: { rulesVersion: string; playerCount: number }): number {
  return isKartaTable(mode.rulesVersion) ? 2 : mode.playerCount;
}

/** A mode whose players gather automatically (no 1v1 challenge, invite or rematch). */
export function isAutoTable(mode: { rulesVersion: string; playerCount: number }): boolean {
  return playersPerMatch(mode) > 2;
}

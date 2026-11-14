/**
 * Board geometry a rules version plays on. Progress is player-relative:
 * -1 = yard, 0..lapSquares-1 = shared track, then `homeColumnLength` private
 * cells, then the finish. The shared loop always has `trackLength` cells, but a
 * colour visits only `lapSquares` of them before turning into its home column.
 */
export type LudoBoardRules = {
  trackLength: number;
  lapSquares: number;
  homeColumnLength: number;
};

/**
 * Historical geometry: every colour walked the whole 52-cell loop (one square
 * past its home-column door) before turning in. Kept so matches created under
 * V1/V2 keep the meaning of their stored progress values.
 */
export const LUDO_LEGACY_BOARD: LudoBoardRules = {
  trackLength: 52,
  lapSquares: 52,
  homeColumnLength: 5,
};

/** Standard board: 51 shared squares per colour, 5 home cells, finish = 56. */
export const LUDO_STANDARD_BOARD: LudoBoardRules = {
  trackLength: 52,
  lapSquares: 51,
  homeColumnLength: 5,
};

export const LUDO_CLASSIC_V1 = {
  version: 'LUDO_CLASSIC_V1' as const,
  minPlayers: 2,
  maxPlayers: 4,
  tokensPerPlayer: 4,
  dieSides: 6,
  requireSixToDeploy: true,
  sixGrantsExtraRoll: true,
  maxConsecutiveSixes: 3,
  thirdConsecutiveSixForfeitsRoll: true,
  captureEnabled: true,
  captureGrantsExtraRoll: false,
  safeSquaresEnabled: true,
  blockadeEnabled: true,
  blockadeMinTokens: 2,
  exactRollToFinish: true,
  finishGrantsExtraRoll: false,
  autoMoveSingleLegal: false,
  firstPlayerMethod: 'HIGHEST_PRE_ROLL' as const,
  direction: 'CLOCKWISE' as const,
  board: LUDO_LEGACY_BOARD,
} as const;

export type LudoClassicV1Rules = typeof LUDO_CLASSIC_V1;

/**
 * Popular rules most players expect: a capture and bringing a token home each
 * earn an extra roll, and when only one move is possible it is played for you.
 * Board, dice and capture rules are otherwise identical to V1.
 */
export const LUDO_CLASSIC_V2 = {
  ...LUDO_CLASSIC_V1,
  version: 'LUDO_CLASSIC_V2' as const,
  captureGrantsExtraRoll: true,
  finishGrantsExtraRoll: true,
  autoMoveSingleLegal: true,
} as const;

/**
 * V2 rules on the standard board: a token turns into its home column right
 * after the square in front of it (51 shared squares, finish at progress 56)
 * instead of walking one square past the door.
 */
export const LUDO_CLASSIC_V3 = {
  ...LUDO_CLASSIC_V2,
  version: 'LUDO_CLASSIC_V3' as const,
  board: LUDO_STANDARD_BOARD,
} as const;

export type LudoRules = typeof LUDO_CLASSIC_V1 | typeof LUDO_CLASSIC_V2 | typeof LUDO_CLASSIC_V3;
export type LudoRulesVersion = LudoRules['version'];

const RULES: Record<LudoRulesVersion, LudoRules> = {
  LUDO_CLASSIC_V1,
  LUDO_CLASSIC_V2,
  LUDO_CLASSIC_V3,
};

export const LUDO_RULES_VERSIONS = Object.keys(RULES) as LudoRulesVersion[];

export function isLudoRulesVersion(version: string): version is LudoRulesVersion {
  return Object.prototype.hasOwnProperty.call(RULES, version);
}

/** Rules for a stored match/state. A match keeps the version it was created with. */
export function rulesFor(version: string): LudoRules {
  if (!isLudoRulesVersion(version)) throw new Error(`Unsupported Ludo rules version: ${version}`);
  return RULES[version];
}

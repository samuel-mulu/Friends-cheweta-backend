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
  trackLength: 52,
  homeColumnLength: 5,
  finishProgress: 57,
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

export type LudoRules = typeof LUDO_CLASSIC_V1 | typeof LUDO_CLASSIC_V2;
export type LudoRulesVersion = LudoRules['version'];

const RULES: Record<LudoRulesVersion, LudoRules> = {
  LUDO_CLASSIC_V1,
  LUDO_CLASSIC_V2,
};

export function isLudoRulesVersion(version: string): version is LudoRulesVersion {
  return Object.prototype.hasOwnProperty.call(RULES, version);
}

/** Rules for a stored match/state. A match keeps the version it was created with. */
export function rulesFor(version: string): LudoRules {
  if (!isLudoRulesVersion(version)) throw new Error(`Unsupported Ludo rules version: ${version}`);
  return RULES[version];
}

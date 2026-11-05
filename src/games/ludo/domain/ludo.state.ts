import { LUDO_BASE_PROGRESS } from './ludo.board';
import { LUDO_CLASSIC_V1, LudoRulesVersion } from './ludo.rules';
import {
  LudoColor,
  LudoGameState,
  LudoMatchPhase,
  LudoPlayerState,
  LudoTokenState,
  LudoTurnPhase,
} from './ludo.types';

/** Tokens needed to finish; old states without the field need all four. */
export function tokensToWinOf(state: Pick<LudoGameState, 'tokensToWin'>): number {
  return state.tokensToWin ?? LUDO_CLASSIC_V1.tokensPerPlayer;
}

export function isValidTokensToWin(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= LUDO_CLASSIC_V1.tokensPerPlayer;
}

export type LudoMatchOptions = {
  /** First to N tokens home (1-4). Default: all four. */
  tokensToWin?: number;
};

function colorsForPlayerCount(count: number): LudoColor[] {
  if (count === 2) return [LudoColor.RED, LudoColor.YELLOW];
  if (count === 3) return [LudoColor.RED, LudoColor.GREEN, LudoColor.YELLOW];
  if (count === 4) return [LudoColor.RED, LudoColor.GREEN, LudoColor.YELLOW, LudoColor.BLUE];
  throw new RangeError('Ludo requires 2 to 4 players.');
}

export function createInitialLudoState(
  matchId: string,
  userIds: string[],
  rulesVersion: LudoRulesVersion = LUDO_CLASSIC_V1.version,
  options: LudoMatchOptions = {},
): LudoGameState {
  if (!matchId.trim()) throw new Error('matchId is required.');
  const tokensToWin = options.tokensToWin ?? LUDO_CLASSIC_V1.tokensPerPlayer;
  if (!isValidTokensToWin(tokensToWin)) throw new RangeError('tokensToWin must be 1 to 4.');
  if (new Set(userIds).size !== userIds.length) throw new Error('Ludo players must be unique.');
  if (userIds.length < LUDO_CLASSIC_V1.minPlayers || userIds.length > LUDO_CLASSIC_V1.maxPlayers) {
    throw new RangeError('Ludo requires 2 to 4 players.');
  }

  const colors = colorsForPlayerCount(userIds.length);
  const players: LudoPlayerState[] = userIds.map((userId, playerIndex) => {
    const color = colors[playerIndex];
    return {
      userId,
      color,
      tokens: Array.from({ length: LUDO_CLASSIC_V1.tokensPerPlayer }, (_, index) => ({
        id: `${color}-${index + 1}`,
        ownerId: userId,
        color,
        state: LudoTokenState.BASE,
        progress: LUDO_BASE_PROGRESS,
      })),
    };
  });

  return {
    rulesVersion,
    matchId,
    version: 0,
    phase: LudoMatchPhase.PRE_GAME,
    turnPhase: LudoTurnPhase.START_ROLL,
    players,
    currentPlayerId: null,
    diceValue: null,
    consecutiveSixes: 0,
    legalTokenIds: [],
    winnerOrder: [],
    tokensToWin,
  };
}

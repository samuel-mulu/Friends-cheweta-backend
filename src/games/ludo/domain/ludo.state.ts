import { LUDO_BASE_PROGRESS } from './ludo.board';
import { LUDO_CLASSIC_V1 } from './ludo.rules';
import {
  LudoColor,
  LudoGameState,
  LudoMatchPhase,
  LudoPlayerState,
  LudoTokenState,
  LudoTurnPhase,
} from './ludo.types';

function colorsForPlayerCount(count: number): LudoColor[] {
  if (count === 2) return [LudoColor.RED, LudoColor.YELLOW];
  if (count === 3) return [LudoColor.RED, LudoColor.GREEN, LudoColor.YELLOW];
  if (count === 4) return [LudoColor.RED, LudoColor.GREEN, LudoColor.YELLOW, LudoColor.BLUE];
  throw new RangeError('Ludo requires 2 to 4 players.');
}

export function createInitialLudoState(matchId: string, userIds: string[]): LudoGameState {
  if (!matchId.trim()) throw new Error('matchId is required.');
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
    rulesVersion: LUDO_CLASSIC_V1.version,
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
  };
}

import type { LudoRulesVersion } from './ludo.rules';

export enum LudoColor {
  RED = 'RED',
  GREEN = 'GREEN',
  YELLOW = 'YELLOW',
  BLUE = 'BLUE',
}

export enum LudoTokenState {
  BASE = 'BASE',
  ACTIVE = 'ACTIVE',
  HOME_PATH = 'HOME_PATH',
  FINISHED = 'FINISHED',
}

export enum LudoMatchPhase {
  PRE_GAME = 'PRE_GAME',
  PLAYING = 'PLAYING',
  FINISHED = 'FINISHED',
}

export enum LudoTurnPhase {
  START_ROLL = 'START_ROLL',
  WAITING_FOR_ROLL = 'WAITING_FOR_ROLL',
  WAITING_FOR_MOVE = 'WAITING_FOR_MOVE',
  COMPLETE = 'COMPLETE',
}

export type LudoToken = {
  id: string;
  ownerId: string;
  color: LudoColor;
  state: LudoTokenState;
  /**
   * Player-relative progress; thresholds come from `boardOf(state)`.
   * -1 = base, 0..trackLast = common track, homeStart..homeLast = home column,
   * finish = home. (V1/V2: 0..51 / 52..56 / 57. V3: 0..50 / 51..55 / 56.)
   */
  progress: number;
};

export type LudoPlayerState = {
  userId: string;
  color: LudoColor;
  tokens: LudoToken[];
};

export type LudoGameState = {
  rulesVersion: LudoRulesVersion;
  matchId: string;
  version: number;
  phase: LudoMatchPhase;
  turnPhase: LudoTurnPhase;
  players: LudoPlayerState[];
  currentPlayerId: string | null;
  diceValue: number | null;
  consecutiveSixes: number;
  legalTokenIds: string[];
  winnerOrder: string[];
  /**
   * Tokens a player must bring home to finish ("first to N home", 1-4).
   * Absent on states created before the option existed: read it with
   * `tokensToWinOf`, which treats absent as all four.
   */
  tokensToWin?: number;
};

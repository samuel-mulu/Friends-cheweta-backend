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
  /** -1 = base, 0..51 = common track, 52..56 = home column, 57 = finished */
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
};

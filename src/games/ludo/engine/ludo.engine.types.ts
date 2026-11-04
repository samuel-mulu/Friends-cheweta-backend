import { LudoToken, LudoTokenState } from '../domain';

export enum LudoMoveKind {
  DEPLOY = 'DEPLOY',
  MOVE = 'MOVE',
}

export type LudoLegalMove = {
  tokenId: string;
  kind: LudoMoveKind;
  fromProgress: number;
  toProgress: number;
  toState: LudoTokenState;
  destinationGlobalSquare: number | null;
  capturedTokenIds: string[];
};

export type LudoMoveResolution = {
  stateVersionBefore: number;
  stateVersionAfter: number;
  playerId: string;
  diceValue: number;
  move: LudoLegalMove;
  tokenBefore: LudoToken;
  tokenAfter: LudoToken;
  capturedTokenIds: string[];
};

/** What the player sees before choosing: where each legal token would land. */
export type LudoMovePreview = {
  tokenId: string;
  toProgress: number;
  captures: string[];
  safe: boolean;
};

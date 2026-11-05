import { LudoGameState } from '../domain';
import { LudoMoveResolution, LudoMovePreview } from '../engine';

export enum LudoRuntimeEventType {
  STARTING_ROLL = 'STARTING_ROLL',
  STARTING_ROLL_TIE = 'STARTING_ROLL_TIE',
  MATCH_STARTED = 'MATCH_STARTED',
  TURN_STARTED = 'TURN_STARTED',
  DICE_ROLLED = 'DICE_ROLLED',
  LEGAL_MOVES_READY = 'LEGAL_MOVES_READY',
  NO_LEGAL_MOVE = 'NO_LEGAL_MOVE',
  THIRD_SIX_FORFEITED = 'THIRD_SIX_FORFEITED',
  TOKEN_MOVED = 'TOKEN_MOVED',
  TOKEN_CAPTURED = 'TOKEN_CAPTURED',
  TOKEN_FINISHED = 'TOKEN_FINISHED',
  EXTRA_ROLL_GRANTED = 'EXTRA_ROLL_GRANTED',
  PLAYER_FINISHED = 'PLAYER_FINISHED',
  PLAYER_RESIGNED = 'PLAYER_RESIGNED',
  MATCH_FINISHED = 'MATCH_FINISHED',
}

export type StartingRollState = {
  round: number;
  candidatePlayerIds: string[];
  rolls: Record<string, number>;
};

export type LudoMatchRuntimeState = {
  game: LudoGameState;
  startingRoll: StartingRollState;
  resignedPlayerIds: string[];
};

export type LudoRuntimeEvent = {
  type: LudoRuntimeEventType;
  matchId: string;
  version: number;
  playerId?: string;
  diceValue?: number;
  tokenId?: string;
  /**
   * TOKEN_CAPTURED: the captured tokens. PLAYER_FINISHED / PLAYER_RESIGNED:
   * the player's unfinished tokens sent back to the yard (player is out).
   */
  tokenIds?: string[];
  winnerOrder?: string[];
  round?: number;
  candidatePlayerIds?: string[];
  move?: LudoMoveResolution;
  /** LEGAL_MOVES_READY: where each legal token would land. */
  legalMoves?: LudoMovePreview[];
};

export type LudoRuntimeCommandBase = {
  commandId: string;
  playerId: string;
  expectedVersion: number;
};

export type RollForStartCommand = LudoRuntimeCommandBase & {
  type: 'ROLL_FOR_START';
};

export type RollDiceCommand = LudoRuntimeCommandBase & {
  type: 'ROLL_DICE';
};

export type MoveTokenCommand = LudoRuntimeCommandBase & {
  type: 'MOVE_TOKEN';
  tokenId: string;
};

export type ResignCommand = LudoRuntimeCommandBase & {
  type: 'RESIGN';
};

export type LudoRuntimeCommand =
  | RollForStartCommand
  | RollDiceCommand
  | MoveTokenCommand
  | ResignCommand;

export type LudoRuntimeResult = {
  commandId: string;
  state: LudoMatchRuntimeState;
  events: LudoRuntimeEvent[];
};

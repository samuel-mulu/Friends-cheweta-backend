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
  /**
   * "Forget to send back and you lose": the player moved another token while
   * a capture was possible, and is out (like a resignation). `tokenId` is the
   * token they chose; `tokenIds` are their tokens retired to the yard.
   */
  CAPTURE_MISSED = 'CAPTURE_MISSED',
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
  /** Players who are out without finishing: resigned, or forfeited (see below). */
  resignedPlayerIds: string[];
  /**
   * Of [resignedPlayerIds], those out because they missed a capture
   * (LUDO_MISSED_CAPTURE_V1). Absent on states stored before it existed.
   */
  missedCapturePlayerIds?: string[];
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
  RollForStartCommand | RollDiceCommand | MoveTokenCommand | ResignCommand;

export type LudoRuntimeResult = {
  commandId: string;
  state: LudoMatchRuntimeState;
  events: LudoRuntimeEvent[];
};

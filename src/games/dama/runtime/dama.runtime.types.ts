import { DamaFinishReason, DamaGameState, DamaMove, DamaResult } from '../domain';

export enum DamaRuntimeEventType {
  PIECE_MOVED = 'PIECE_MOVED',
  TURN_STARTED = 'TURN_STARTED',
  PLAYER_RESIGNED = 'PLAYER_RESIGNED',
  MATCH_FINISHED = 'MATCH_FINISHED',
}

/** Wrapper kept for symmetry with Ludo (`state.game` is what stores and timers read). */
export type DamaMatchRuntimeState = {
  game: DamaGameState;
};

export type DamaRuntimeEvent = {
  type: DamaRuntimeEventType;
  matchId: string;
  version: number;
  playerId?: string;
  /** PIECE_MOVED */
  move?: DamaMove;
  promoted?: boolean;
  /** TURN_STARTED: what the player to move may play. */
  legalMoves?: DamaMove[];
  /** MATCH_FINISHED */
  winnerOrder?: string[];
  result?: DamaResult;
  reason?: DamaFinishReason;
};

type CommandBase = {
  commandId: string;
  playerId: string;
  expectedVersion: number;
};

export type DamaMoveCommand = CommandBase & {
  type: 'MOVE';
  /** Start square followed by every landing square (multi-captures included). */
  path: number[];
};

export type DamaResignCommand = CommandBase & {
  type: 'RESIGN';
};

export type DamaRuntimeCommand = DamaMoveCommand | DamaResignCommand;

export type DamaRuntimeResult = {
  commandId: string;
  state: DamaMatchRuntimeState;
  events: DamaRuntimeEvent[];
};

import type { LudoBoardSpec } from '../games/ludo/domain';
import type { LudoMovePreview } from '../games/ludo/engine';
import { DefaultEventsMap, Socket } from 'socket.io';
import { UserRole, UserStatus } from '../generated/prisma/enums';
import { LudoMatchRuntimeState, LudoRuntimeEvent } from '../games/ludo/runtime';
import type { TurnTiming } from './turn-game/turn-game-timer';

export const REALTIME_PROTOCOL_VERSION = 1 as const;

export type RealtimeUser = {
  id: string;
  fullName: string;
  phoneNumber: string;
  role: UserRole;
  status: UserStatus;
};

export type SocketData = {
  user?: RealtimeUser;
  presenceTimer?: NodeJS.Timeout;
};

export type AuthenticatedSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  SocketData
>;

export type RealtimeEnvelope<T> = {
  protocolVersion: typeof REALTIME_PROTOCOL_VERSION;
  eventId: string;
  serverTime: string;
  matchId?: string;
  version?: number;
  /** Set on runtime events: id of the command that produced this burst and the event's place in it. */
  batchId?: string;
  batchIndex?: number;
  batchSize?: number;
  data: T;
};

export type CommandAck =
  | {
      ok: true;
      commandId: string;
      version: number;
      duplicate: boolean;
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

/** Ludo join/sync ack (the shape the Flutter client parses). */
export type SnapshotAck =
  | {
      ok: true;
      state: LudoMatchRuntimeState;
      timing: TurnTiming;
      version: number;
      participants: LudoMatchParticipantView[];
      recentMessages?: unknown[];
      /** Where each legal token would land (when the current player must move). */
      legalMoves?: LudoMovePreview[];
      /** Resolved board geometry for this match's rules version (progress thresholds). */
      board?: LudoBoardSpec;
    }
  | { ok: false; code: string; message: string };

export type LudoMatchParticipantView = {
  userId: string;
  fullName: string;
  seat: number;
  color: string | null;
};

export type RuntimeExecution = {
  commandId: string;
  version: number;
  duplicate: boolean;
  state: LudoMatchRuntimeState;
  events: LudoRuntimeEvent[];
};

import { Socket } from 'socket.io';
import { UserRole, UserStatus } from '../generated/prisma/enums';
import { LudoMatchRuntimeState, LudoRuntimeEvent } from '../games/ludo/runtime';
import { LudoTimingState } from './timeout/turn-timeout.types';

export const REALTIME_PROTOCOL_VERSION = 1 as const;

export type RealtimeUser = {
  id: string;
  fullName: string;
  phoneNumber: string;
  role: UserRole;
  status: UserStatus;
};

export type AuthenticatedSocket = Socket & {
  data: {
    user?: RealtimeUser;
    presenceTimer?: NodeJS.Timeout;
  };
};

export type RealtimeEnvelope<T> = {
  protocolVersion: typeof REALTIME_PROTOCOL_VERSION;
  eventId: string;
  serverTime: string;
  matchId?: string;
  version?: number;
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

export type SnapshotAck =
  | {
      ok: true;
      state: LudoMatchRuntimeState;
      timing: LudoTimingState;
      version: number;
      participants: LudoMatchParticipantView[];
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

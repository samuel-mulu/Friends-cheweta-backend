import { LudoTurnPhase } from '../../games/ludo/domain';

export type LudoTimingState = {
  matchId: string;
  version: number;
  playerId: string | null;
  turnPhase: LudoTurnPhase;
  turnEndsAt: string | null;
  consecutiveTimeoutsByPlayer: Record<string, number>;
};

export type RealtimeLudoSnapshot = {
  state: import('../../games/ludo/runtime').LudoMatchRuntimeState;
  timing: LudoTimingState;
};

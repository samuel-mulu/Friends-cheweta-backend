export type QueueEntry = {
  ticketId: string;
  userId: string;
  gameModeId: string;
  joinedAtMs: number;
};

export type MatchmakingQueuedResult = {
  status: 'QUEUED';
  ticketId: string;
  gameModeId: string;
};

export type MatchmakingMatchedResult = {
  status: 'MATCHED';
  gameModeId: string;
  match: any;
  userIds: string[];
};

export type MatchmakingJoinResult = MatchmakingQueuedResult | MatchmakingMatchedResult;

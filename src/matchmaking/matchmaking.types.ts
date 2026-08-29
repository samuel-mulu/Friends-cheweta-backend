export type ReadyEntry = {
  ticketId: string;
  userId: string;
  gameModeId: string;
  matchId: string;
  displayName: string;
  readyAtMs: number;
};

export type ReadyPlayerView = {
  ticketId: string;
  userId: string;
  displayName: string;
  readyAtMs: number;
  stakeAmountMinor: string;
  isSelf?: boolean;
};

export type MatchmakingQueuedResult = {
  status: 'QUEUED';
  ticketId: string;
  gameModeId: string;
  matchId: string;
  players: ReadyPlayerView[];
};

export type MatchmakingMatchedResult = {
  status: 'MATCHED';
  gameModeId: string;
  match: any;
  userIds: string[];
};

export type MatchmakingJoinResult = MatchmakingQueuedResult | MatchmakingMatchedResult;

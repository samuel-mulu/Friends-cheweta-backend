export type LobbyPlayerState = 'ONLINE' | 'READY' | 'CHALLENGED';

export type LobbyUserContext = {
  gameModeId: string;
  state: LobbyPlayerState;
  joinedAt: string;
  readyAt?: string;
};

export type LobbyPlayerView = {
  userId: string;
  displayName: string;
  state: LobbyPlayerState;
  readyAt?: string;
  isSelf?: boolean;
};

export type LobbyGameModeView = {
  id: string;
  code: string;
  name: string;
  stakeAmountMinor: string;
  currency: 'ETB';
};

export type LobbySnapshot = {
  gameMode: LobbyGameModeView;
  myState: LobbyPlayerState;
  players: LobbyPlayerView[];
  activeChallenge?: unknown;
  recentMessages?: unknown[];
  serverTime: string;
};

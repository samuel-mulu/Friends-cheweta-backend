/** Lobby context TTL; refreshed by the socket heartbeat while connected. */
export const LOBBY_TTL_SECONDS = 180;

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
  /** The stake (game mode) the player sits at. */
  gameModeId: string;
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

/** One stake of a game, with how many players sit at it. */
export type LobbyStakeView = {
  id: string;
  stakeAmountMinor: string;
  onlineCount: number;
  readyCount: number;
};

/** Everyone in a game's lobby, at every stake. */
export type LobbyGameSnapshot = {
  game: { id: string; code: string; name: string };
  /** Enabled stakes, smallest first. */
  stakes: LobbyStakeView[];
  /** The viewer's stake. */
  gameModeId: string;
  myState: LobbyPlayerState;
  players: LobbyPlayerView[];
  recentMessages?: unknown[];
  serverTime: string;
};

export type LobbySnapshot = {
  gameMode: LobbyGameModeView;
  myState: LobbyPlayerState;
  players: LobbyPlayerView[];
  activeChallenge?: unknown;
  recentMessages?: unknown[];
  serverTime: string;
};

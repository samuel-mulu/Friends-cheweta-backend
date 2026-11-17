/** Lobby context TTL; refreshed by the socket heartbeat while connected. */
export const LOBBY_TTL_SECONDS = 180;

export type LobbyPlayerState = 'ONLINE' | 'READY' | 'CHALLENGED';

/** Custom stakes: whole birr, 5 to 10,000 ETB (minor units). */
export const CUSTOM_STAKE_MIN_MINOR = 500;
export const CUSTOM_STAKE_MAX_MINOR = 1_000_000;

export type LobbyUserContext = {
  gameModeId: string;
  /** The stake's amount, so player views can show it without a lookup. */
  stakeAmountMinor?: string;
  state: LobbyPlayerState;
  joinedAt: string;
  readyAt?: string;
};

export type LobbyPlayerView = {
  userId: string;
  displayName: string;
  /** The stake (game mode) the player sits at, and its amount. */
  gameModeId: string;
  stakeAmountMinor?: string;
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
  code: string;
  name: string;
  stakeAmountMinor: string;
  playerCount: number;
  platformFeeBps: number;
  turnDurationSeconds: number;
  rulesVersion: string;
  /** Chosen by a player rather than listed in the catalog. */
  custom: boolean;
  onlineCount: number;
  readyCount: number;
};

/** Everyone in a game's lobby, at every stake. */
export type LobbyGameSnapshot = {
  game: { id: string; code: string; name: string };
  /** Catalog stakes plus custom stakes someone sits at, smallest first. */
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

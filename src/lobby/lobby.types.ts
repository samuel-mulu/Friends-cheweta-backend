/** Lobby context TTL; refreshed by the socket heartbeat while connected. */
export const LOBBY_TTL_SECONDS = 180;

export type LobbyPlayerState = 'ONLINE' | 'READY' | 'CHALLENGED';

/** Custom stakes: whole birr, 5 to 10,000 ETB (minor units). */
export const CUSTOM_STAKE_MIN_MINOR = 500;
export const CUSTOM_STAKE_MAX_MINOR = 1_000_000;

/**
 * Custom stake codes are `<GAME>_CUSTOM_<amount>`; a rules version listed here
 * gets its own stake per amount (`..._<suffix>`), e.g. Dama እግረኛ.
 */
export const CUSTOM_CODE_SUFFIX: Readonly<Record<string, string>> = {
  DAMA_ET_FORWARD_V1: 'FWD',
  LUDO_NO_CAPTURE_V1: 'NOCAP',
  LUDO_MISSED_CAPTURE_V1: 'MISS',
};

/** What a player asks for when they get ready (kept while READY or CHALLENGED). */
export type LobbyReadyPrefs = {
  /** Ludo "first to N home" (1-4) the player wants to play; other games: absent. */
  tokensToWin?: number;
  /** Start a match on its own with the next player ready at the same terms (default on). */
  autoMatch?: boolean;
};

/** Ludo goal when the player did not say: all four home. */
export const DEFAULT_TOKENS_TO_WIN = 4;

export type LobbyUserContext = LobbyReadyPrefs & {
  gameModeId: string;
  /** The stake's amount, so player views can show it without a lookup. */
  stakeAmountMinor?: string;
  state: LobbyPlayerState;
  joinedAt: string;
  readyAt?: string;
};

export type LobbyPlayerView = LobbyReadyPrefs & {
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

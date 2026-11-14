import {
  LUDO_BASE_PROGRESS,
  boardOf,
  isCommonTrackProgress,
  isFinishedProgress,
  isHomePathProgress,
  isSafeGlobalSquare,
  toGlobalTrackIndex,
} from './ludo.board';
import { LUDO_CLASSIC_V1, isLudoRulesVersion } from './ludo.rules';
import { isValidTokensToWin } from './ludo.state';
import { LudoGameState, LudoTokenState } from './ludo.types';

export function assertValidLudoState(state: LudoGameState): void {
  if (!isLudoRulesVersion(state.rulesVersion)) throw new Error('Unsupported Ludo rules version.');
  if (!Number.isInteger(state.version) || state.version < 0) throw new Error('State version must be non-negative.');
  if (state.players.length < 2 || state.players.length > 4) throw new Error('Invalid player count.');
  if (state.tokensToWin !== undefined && !isValidTokensToWin(state.tokensToWin)) {
    throw new Error('Invalid tokensToWin.');
  }

  const board = boardOf(state);
  const userIds = new Set<string>();
  const tokenIds = new Set<string>();
  const colors = new Set<string>();

  for (const player of state.players) {
    if (userIds.has(player.userId)) throw new Error('Duplicate player.');
    if (colors.has(player.color)) throw new Error('Duplicate player color.');
    if (player.tokens.length !== LUDO_CLASSIC_V1.tokensPerPlayer) throw new Error('Invalid token count.');
    userIds.add(player.userId);
    colors.add(player.color);

    for (const token of player.tokens) {
      if (tokenIds.has(token.id)) throw new Error('Duplicate token id.');
      if (token.ownerId !== player.userId || token.color !== player.color) throw new Error('Token ownership mismatch.');
      tokenIds.add(token.id);

      const valid =
        (token.state === LudoTokenState.BASE && token.progress === LUDO_BASE_PROGRESS) ||
        (token.state === LudoTokenState.ACTIVE && isCommonTrackProgress(board, token.progress)) ||
        (token.state === LudoTokenState.HOME_PATH && isHomePathProgress(board, token.progress)) ||
        (token.state === LudoTokenState.FINISHED && isFinishedProgress(board, token.progress));
      if (!valid) throw new Error(`Invalid token state/progress for ${token.id}.`);
      if (token.progress > board.finish) throw new Error('Token overshot finish.');
    }
  }

  // Shared-track occupancy must be reachable under the classic rules.
  // Different owners may coexist only on a safe square, and an opponent can
  // never coexist with a same-owner blockade (2+ tokens), even on a safe square.
  const occupancy = new Map<number, Map<string, number>>();
  for (const player of state.players) {
    for (const token of player.tokens) {
      if (!isCommonTrackProgress(board, token.progress)) continue;
      const square = toGlobalTrackIndex(board, token.color, token.progress);
      const owners = occupancy.get(square) ?? new Map<string, number>();
      owners.set(player.userId, (owners.get(player.userId) ?? 0) + 1);
      occupancy.set(square, owners);
    }
  }
  for (const [square, owners] of occupancy) {
    if (owners.size <= 1) continue;
    if (!isSafeGlobalSquare(square)) {
      throw new Error(`Opposing tokens cannot coexist on non-safe square ${square}.`);
    }
    if ([...owners.values()].some((count) => count >= LUDO_CLASSIC_V1.blockadeMinTokens)) {
      throw new Error(`Opponent cannot coexist with a blockade on square ${square}.`);
    }
  }

  if (state.currentPlayerId !== null && !userIds.has(state.currentPlayerId)) {
    throw new Error('Current player is not part of this game.');
  }
  if (state.diceValue !== null && (!Number.isInteger(state.diceValue) || state.diceValue < 1 || state.diceValue > 6)) {
    throw new Error('Invalid dice value.');
  }
  if (state.consecutiveSixes < 0 || state.consecutiveSixes >= LUDO_CLASSIC_V1.maxConsecutiveSixes) {
    throw new Error('Invalid consecutive six count.');
  }
  for (const tokenId of state.legalTokenIds) {
    if (!tokenIds.has(tokenId)) throw new Error('Legal move references an unknown token.');
  }
}

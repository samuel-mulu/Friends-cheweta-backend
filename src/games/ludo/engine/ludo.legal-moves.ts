import {
  LUDO_BASE_PROGRESS,
  LUDO_CLASSIC_V1,
  LudoBoardSpec,
  boardOf,
  isCommonTrackProgress,
  isSafeGlobalSquare,
  progressPath,
  toGlobalTrackIndex,
} from '../domain';
import { LudoGameState, LudoToken, LudoTokenState } from '../domain';
import { LudoLegalMove, LudoMoveKind } from './ludo.engine.types';
import {
  getOpponentBlockadeSquares,
  getOpponentTokensOnGlobalSquare,
  getPlayerTokensOnGlobalSquare,
  getTraversedCommonTrackSquares,
} from './ludo.position';

function assertDice(diceValue: number): void {
  if (!Number.isInteger(diceValue) || diceValue < 1 || diceValue > LUDO_CLASSIC_V1.dieSides) {
    throw new RangeError('Dice value must be an integer from 1 to 6.');
  }
}

function targetState(board: LudoBoardSpec, progress: number): LudoTokenState {
  if (progress === board.finish) return LudoTokenState.FINISHED;
  if (progress >= board.homeStart) return LudoTokenState.HOME_PATH;
  return LudoTokenState.ACTIVE;
}

function captureIdsAtDestination(
  state: LudoGameState,
  ownerId: string,
  globalSquare: number | null,
): string[] {
  if (globalSquare === null || isSafeGlobalSquare(globalSquare)) return [];
  return getOpponentTokensOnGlobalSquare(state, ownerId, globalSquare).map((token) => token.id);
}

function wouldCreateBlockadeWithOpponent(
  state: LudoGameState,
  ownerId: string,
  globalSquare: number,
): boolean {
  if (!isSafeGlobalSquare(globalSquare)) return false;
  const opponents = getOpponentTokensOnGlobalSquare(state, ownerId, globalSquare);
  if (opponents.length === 0) return false;
  const ownTokens = getPlayerTokensOnGlobalSquare(state, ownerId, globalSquare);
  return ownTokens.length + 1 >= LUDO_CLASSIC_V1.blockadeMinTokens;
}

function isBlockedByOpponent(
  state: LudoGameState,
  board: LudoBoardSpec,
  token: LudoToken,
  fromProgress: number,
  toProgress: number,
): boolean {
  const blockadeSquares = getOpponentBlockadeSquares(state, token.ownerId);
  if (blockadeSquares.size === 0) return false;
  return getTraversedCommonTrackSquares(board, token.color, fromProgress, toProgress).some((square) =>
    blockadeSquares.has(square),
  );
}

function buildDeployMove(
  state: LudoGameState,
  board: LudoBoardSpec,
  token: LudoToken,
  diceValue: number,
): LudoLegalMove | null {
  if (token.state !== LudoTokenState.BASE) return null;
  if (LUDO_CLASSIC_V1.requireSixToDeploy && diceValue !== 6) return null;

  const destination = toGlobalTrackIndex(board, token.color, 0);
  const blockadeSquares = getOpponentBlockadeSquares(state, token.ownerId);
  if (blockadeSquares.has(destination)) return null;
  if (wouldCreateBlockadeWithOpponent(state, token.ownerId, destination)) return null;

  return {
    tokenId: token.id,
    kind: LudoMoveKind.DEPLOY,
    fromProgress: LUDO_BASE_PROGRESS,
    toProgress: 0,
    toState: LudoTokenState.ACTIVE,
    destinationGlobalSquare: destination,
    capturedTokenIds: captureIdsAtDestination(state, token.ownerId, destination),
    path: progressPath(LUDO_BASE_PROGRESS, 0),
  };
}

function buildTrackMove(
  state: LudoGameState,
  board: LudoBoardSpec,
  token: LudoToken,
  diceValue: number,
): LudoLegalMove | null {
  if (token.state === LudoTokenState.BASE || token.state === LudoTokenState.FINISHED) return null;

  const destinationProgress = token.progress + diceValue;
  // Exact roll into home: anything past the finish is not a move at all.
  if (destinationProgress > board.finish) return null;
  if (isBlockedByOpponent(state, board, token, token.progress, destinationProgress)) return null;

  const destinationGlobalSquare = isCommonTrackProgress(board, destinationProgress)
    ? toGlobalTrackIndex(board, token.color, destinationProgress)
    : null;
  if (
    destinationGlobalSquare !== null &&
    wouldCreateBlockadeWithOpponent(state, token.ownerId, destinationGlobalSquare)
  ) return null;

  return {
    tokenId: token.id,
    kind: LudoMoveKind.MOVE,
    fromProgress: token.progress,
    toProgress: destinationProgress,
    toState: targetState(board, destinationProgress),
    destinationGlobalSquare,
    capturedTokenIds: captureIdsAtDestination(state, token.ownerId, destinationGlobalSquare),
    path: progressPath(token.progress, destinationProgress),
  };
}

export function getLegalMoves(
  state: LudoGameState,
  playerId: string,
  diceValue: number,
): LudoLegalMove[] {
  assertDice(diceValue);
  const player = state.players.find((item) => item.userId === playerId);
  if (!player) throw new Error('Player is not part of this Ludo game.');
  const board = boardOf(state);

  return player.tokens.flatMap((token) => {
    const move =
      token.state === LudoTokenState.BASE
        ? buildDeployMove(state, board, token, diceValue)
        : buildTrackMove(state, board, token, diceValue);
    return move ? [move] : [];
  });
}

export function getLegalTokenIds(
  state: LudoGameState,
  playerId: string,
  diceValue: number,
): string[] {
  return getLegalMoves(state, playerId, diceValue).map((move) => move.tokenId);
}

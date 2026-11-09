import {
  DAMA_DRAW_PLIES,
  DAMA_ET_V1,
  DamaColor,
  DamaFinishReason,
  DamaGameState,
  DamaMove,
  DamaPhase,
  assertValidDamaState,
  countPieces,
  initialBoard,
  isKing,
  opponentOf,
} from '../domain';
import { applyMove, legalMoves, sameMove } from '../engine';
import {
  DamaMatchRuntimeState,
  DamaMoveCommand,
  DamaResignCommand,
  DamaRuntimeCommand,
  DamaRuntimeEvent,
  DamaRuntimeEventType,
  DamaRuntimeResult,
} from './dama.runtime.types';

/** A new match: `lightUserId` moves first. Color assignment is the caller's choice. */
export function createDamaMatch(matchId: string, lightUserId: string, darkUserId: string): DamaMatchRuntimeState {
  const game: DamaGameState = {
    matchId,
    rulesVersion: DAMA_ET_V1,
    version: 0,
    phase: DamaPhase.PLAYING,
    players: [
      { userId: lightUserId, color: DamaColor.LIGHT },
      { userId: darkUserId, color: DamaColor.DARK },
    ],
    board: initialBoard(),
    currentPlayerId: lightUserId,
    plyCount: 0,
    pliesSinceProgress: 0,
    lastMove: null,
    winnerOrder: [],
    result: null,
    finishReason: null,
  };
  assertValidDamaState(game);
  return { game };
}

export function colorOfPlayer(game: DamaGameState, userId: string): DamaColor {
  const player = game.players.find((candidate) => candidate.userId === userId);
  if (!player) throw new Error('PLAYER_NOT_IN_MATCH');
  return player.color;
}

/** Moves available to the player whose turn it is (empty once finished). */
export function currentLegalMoves(state: DamaMatchRuntimeState): DamaMove[] {
  const { game } = state;
  if (game.phase !== DamaPhase.PLAYING || !game.currentPlayerId) return [];
  return legalMoves(game.board, colorOfPlayer(game, game.currentPlayerId));
}

/**
 * Pure and deterministic: validates `command` against `state` and returns the
 * next state plus the events to publish. Never mutates its input.
 */
export function executeDamaCommand(state: DamaMatchRuntimeState, command: DamaRuntimeCommand): DamaRuntimeResult {
  if (!command.commandId.trim()) throw new Error('COMMAND_ID_REQUIRED');
  const { game } = state;
  if (game.phase !== DamaPhase.PLAYING) throw new Error('MATCH_NOT_PLAYING');
  if (command.expectedVersion !== game.version) throw new Error('MATCH_VERSION_CONFLICT');
  colorOfPlayer(game, command.playerId); // membership

  switch (command.type) {
    case 'MOVE':
      return move(state, command);
    case 'RESIGN':
      return resign(state, command);
    default: {
      const exhaustive: never = command;
      throw new Error(`Unsupported command: ${String(exhaustive)}`);
    }
  }
}

function move(state: DamaMatchRuntimeState, command: DamaMoveCommand): DamaRuntimeResult {
  const { game } = state;
  if (game.currentPlayerId !== command.playerId) throw new Error('NOT_PLAYER_TURN');
  const color = colorOfPlayer(game, command.playerId);
  const chosen = legalMoves(game.board, color).find((candidate) => sameMove(candidate, command));
  if (!chosen) throw new Error('ILLEGAL_DAMA_MOVE');

  const movedMan = !isKing(game.board[chosen.path[0]]);
  const { board, promoted } = applyMove(game.board, chosen);
  const version = game.version + 1;
  const progress = chosen.captured.length > 0 || movedMan;
  const opponent = game.players.find((player) => player.color === opponentOf(color))!;

  let next: DamaGameState = {
    ...game,
    version,
    board,
    plyCount: game.plyCount + 1,
    pliesSinceProgress: progress ? 0 : game.pliesSinceProgress + 1,
    lastMove: chosen,
    currentPlayerId: opponent.userId,
  };
  const events: DamaRuntimeEvent[] = [
    { type: DamaRuntimeEventType.PIECE_MOVED, matchId: game.matchId, version, playerId: command.playerId, move: chosen, promoted },
  ];

  const replies = legalMoves(board, opponent.color);
  if (countPieces(board, opponent.color) === 0) {
    next = finish(next, command.playerId, 'NO_PIECES');
  } else if (replies.length === 0) {
    next = finish(next, command.playerId, 'NO_MOVES'); // blocked = loss
  } else if (next.pliesSinceProgress >= DAMA_DRAW_PLIES) {
    next = finish(next, null, 'DRAW_RULE');
  } else {
    events.push({
      type: DamaRuntimeEventType.TURN_STARTED,
      matchId: game.matchId,
      version,
      playerId: opponent.userId,
      legalMoves: replies,
    });
  }
  if (next.phase === DamaPhase.FINISHED) events.push(finishedEvent(next));

  assertValidDamaState(next);
  return { commandId: command.commandId, state: { game: next }, events };
}

function resign(state: DamaMatchRuntimeState, command: DamaResignCommand): DamaRuntimeResult {
  const { game } = state;
  const winner = game.players.find((player) => player.userId !== command.playerId)!;
  const version = game.version + 1;
  const next = finish({ ...game, version }, winner.userId, 'RESIGN');
  assertValidDamaState(next);
  return {
    commandId: command.commandId,
    state: { game: next },
    events: [
      { type: DamaRuntimeEventType.PLAYER_RESIGNED, matchId: game.matchId, version, playerId: command.playerId },
      finishedEvent(next),
    ],
  };
}

/** `winnerId` null means a draw. */
function finish(game: DamaGameState, winnerId: string | null, reason: DamaFinishReason): DamaGameState {
  const loserId = game.players.find((player) => player.userId !== winnerId)!.userId;
  return {
    ...game,
    phase: DamaPhase.FINISHED,
    currentPlayerId: null,
    winnerOrder: winnerId ? [winnerId, loserId] : [],
    result: winnerId ? 'WIN' : 'DRAW',
    finishReason: reason,
  };
}

function finishedEvent(game: DamaGameState): DamaRuntimeEvent {
  return {
    type: DamaRuntimeEventType.MATCH_FINISHED,
    matchId: game.matchId,
    version: game.version,
    winnerOrder: [...game.winnerOrder],
    result: game.result!,
    reason: game.finishReason!,
  };
}

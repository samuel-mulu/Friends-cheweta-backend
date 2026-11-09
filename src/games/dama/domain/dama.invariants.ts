import { colorOf, countPieces, isDarkSquare, isKing, promotionRow, rowOf } from './dama.board';
import { DAMA_DRAW_PLIES, DAMA_PIECES_PER_PLAYER, DamaColor, DamaGameState, DamaPhase } from './dama.types';

/** Throws `DAMA_INVARIANT_*` when the state could not have come from legal play. */
export function assertValidDamaState(state: DamaGameState): void {
  const fail = (what: string): never => {
    throw new Error(`DAMA_INVARIANT_${what}`);
  };

  if (state.board.length !== 64) fail('BOARD_SIZE');
  if (state.players.length !== 2) fail('PLAYER_COUNT');
  if (state.players[0].color !== DamaColor.LIGHT || state.players[1].color !== DamaColor.DARK) fail('PLAYER_COLORS');
  if (state.players[0].userId === state.players[1].userId) fail('DUPLICATE_PLAYER');

  for (let square = 0; square < 64; square += 1) {
    const cell = state.board[square];
    const color = colorOf(cell);
    if (cell !== '.' && color === null) fail('UNKNOWN_CELL');
    if (color === null) continue;
    if (!isDarkSquare(square)) fail('PIECE_ON_LIGHT_SQUARE');
    if (!isKing(cell) && rowOf(square) === promotionRow(color)) fail('UNCROWNED_MAN');
  }
  for (const color of [DamaColor.LIGHT, DamaColor.DARK]) {
    if (countPieces(state.board, color) > DAMA_PIECES_PER_PLAYER) fail('TOO_MANY_PIECES');
  }

  if (state.pliesSinceProgress < 0 || state.pliesSinceProgress > DAMA_DRAW_PLIES) fail('DRAW_COUNTER');
  const ids = state.players.map((player) => player.userId);
  if (state.phase === DamaPhase.PLAYING) {
    if (!state.currentPlayerId || !ids.includes(state.currentPlayerId)) fail('CURRENT_PLAYER');
    if (state.result !== null || state.winnerOrder.length > 0) fail('RESULT_WHILE_PLAYING');
  } else {
    if (state.currentPlayerId !== null) fail('CURRENT_PLAYER_AFTER_FINISH');
    if (state.result === 'WIN' && (state.winnerOrder.length !== 2 || !ids.includes(state.winnerOrder[0]))) fail('WINNER_ORDER');
    if (state.result === 'DRAW' && state.winnerOrder.length !== 0) fail('DRAW_WITH_WINNER');
    if (!state.result || !state.finishReason) fail('MISSING_RESULT');
  }
}

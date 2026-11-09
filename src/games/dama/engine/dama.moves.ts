import {
  DIAGONALS,
  colOf,
  colorOf,
  forwardRow,
  isKing,
  kingOf,
  onBoard,
  promotionRow,
  rowOf,
  squareAt,
} from '../domain/dama.board';
import { DamaBoard, DamaColor, DamaMove, EMPTY } from '../domain/dama.types';

/**
 * Every legal move for `color` under DAMA_ET_V1:
 * - capturing is compulsory, and only the sequences that capture the most
 *   pieces are legal (each piece counts 1, kings included);
 * - otherwise the quiet moves (men one step forward, kings slide any distance).
 */
export function legalMoves(board: DamaBoard, color: DamaColor): DamaMove[] {
  const captures: DamaMove[] = [];
  for (let square = 0; square < 64; square += 1) {
    if (colorOf(board[square]) === color) captures.push(...captureSequences(board, square));
  }
  if (captures.length > 0) {
    const most = Math.max(...captures.map((move) => move.captured.length));
    return captures.filter((move) => move.captured.length === most);
  }

  const quiet: DamaMove[] = [];
  for (let square = 0; square < 64; square += 1) {
    if (colorOf(board[square]) === color) quiet.push(...quietMoves(board, square));
  }
  return quiet;
}

/** The pieces that may move now (all must-capture pieces when a capture exists). */
export function movableSquares(moves: DamaMove[]): number[] {
  return [...new Set(moves.map((move) => move.path[0]))];
}

function quietMoves(board: DamaBoard, from: number): DamaMove[] {
  const piece = board[from];
  const color = colorOf(piece)!;
  const moves: DamaMove[] = [];
  for (const [dRow, dCol] of DIAGONALS) {
    if (!isKing(piece) && dRow !== forwardRow(color)) continue;
    let row = rowOf(from) + dRow;
    let col = colOf(from) + dCol;
    while (onBoard(row, col) && board[squareAt(row, col)] === EMPTY) {
      moves.push({ path: [from, squareAt(row, col)], captured: [] });
      if (!isKing(piece)) break; // a man steps once; a king flies
      row += dRow;
      col += dCol;
    }
  }
  return moves;
}

/**
 * All maximal capture sequences starting at `from` (depth-first). The moving
 * piece leaves its start square, captured pieces stay on the board until the
 * move ends (they block and can't be jumped twice). A man that passes the far
 * row mid-capture keeps capturing as a man; it is crowned only if it ends there.
 */
function captureSequences(board: DamaBoard, from: number): DamaMove[] {
  const piece = board[from];
  const color = colorOf(piece)!;
  const king = isKing(piece);
  const results: DamaMove[] = [];

  const cellAt = (square: number): string => (square === from ? EMPTY : board[square]);

  const search = (at: number, path: number[], captured: number[]): void => {
    let extended = false;
    for (const [dRow, dCol] of DIAGONALS) {
      let row = rowOf(at) + dRow;
      let col = colOf(at) + dCol;
      // Kings may fly over empty squares to reach the victim.
      if (king) {
        while (onBoard(row, col) && cellAt(squareAt(row, col)) === EMPTY) {
          row += dRow;
          col += dCol;
        }
      }
      if (!onBoard(row, col)) continue;
      const victim = squareAt(row, col);
      if (colorOf(cellAt(victim)) === color || cellAt(victim) === EMPTY) continue;
      if (captured.includes(victim)) continue; // already taken: blocks this line

      row += dRow;
      col += dCol;
      while (onBoard(row, col) && cellAt(squareAt(row, col)) === EMPTY) {
        const landing = squareAt(row, col);
        extended = true;
        search(landing, [...path, landing], [...captured, victim]);
        if (!king) break; // a man lands right behind the victim
        row += dRow;
        col += dCol;
      }
    }
    if (!extended && captured.length > 0) results.push({ path, captured });
  };

  search(from, [from], []);
  return results;
}

/** The board after `move`; crowns a man that ends on its far row. */
export function applyMove(board: DamaBoard, move: DamaMove): { board: DamaBoard; promoted: boolean } {
  const cells = board.split('');
  const from = move.path[0];
  const to = move.path[move.path.length - 1];
  const piece = cells[from];
  const color = colorOf(piece)!;
  cells[from] = EMPTY;
  for (const square of move.captured) cells[square] = EMPTY;
  const promoted = !isKing(piece) && rowOf(to) === promotionRow(color);
  cells[to] = promoted ? kingOf(color) : piece;
  return { board: cells.join(''), promoted };
}

export function sameMove(a: DamaMove, b: { path: number[] }): boolean {
  return a.path.length === b.path.length && a.path.every((square, index) => square === b.path[index]);
}

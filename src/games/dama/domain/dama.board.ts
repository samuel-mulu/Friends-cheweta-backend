import { DamaBoard, DamaCell, DamaColor, EMPTY } from './dama.types';

export const BOARD_SIZE = 8;

export const rowOf = (square: number): number => Math.floor(square / BOARD_SIZE);
export const colOf = (square: number): number => square % BOARD_SIZE;
export const squareAt = (row: number, col: number): number => row * BOARD_SIZE + col;

export const onBoard = (row: number, col: number): boolean =>
  row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;

export const isDarkSquare = (square: number): boolean =>
  square >= 0 && square < 64 && (rowOf(square) + colOf(square)) % 2 === 0;

/** The four diagonal directions as [dRow, dCol]. */
export const DIAGONALS: ReadonlyArray<readonly [number, number]> = [
  [1, -1],
  [1, 1],
  [-1, -1],
  [-1, 1],
];

/** Light moves up the rows, Dark down. */
export const forwardRow = (color: DamaColor): number => (color === DamaColor.LIGHT ? 1 : -1);

/** The row where a man of this color is crowned. */
export const promotionRow = (color: DamaColor): number => (color === DamaColor.LIGHT ? BOARD_SIZE - 1 : 0);

export const colorOf = (cell: string): DamaColor | null => {
  if (cell === 'l' || cell === 'L') return DamaColor.LIGHT;
  if (cell === 'd' || cell === 'D') return DamaColor.DARK;
  return null;
};

export const isKing = (cell: string): boolean => cell === 'L' || cell === 'D';

export const manOf = (color: DamaColor): DamaCell => (color === DamaColor.LIGHT ? 'l' : 'd');
export const kingOf = (color: DamaColor): DamaCell => (color === DamaColor.LIGHT ? 'L' : 'D');

export const opponentOf = (color: DamaColor): DamaColor =>
  color === DamaColor.LIGHT ? DamaColor.DARK : DamaColor.LIGHT;

/** 12 men each: Light on rows 0-2, Dark on rows 5-7, dark squares only. */
export function initialBoard(): DamaBoard {
  let board = '';
  for (let square = 0; square < 64; square += 1) {
    const row = rowOf(square);
    if (!isDarkSquare(square)) board += EMPTY;
    else if (row <= 2) board += 'l';
    else if (row >= 5) board += 'd';
    else board += EMPTY;
  }
  return board;
}

export function countPieces(board: DamaBoard, color: DamaColor): number {
  let count = 0;
  for (const cell of board) if (colorOf(cell) === color) count += 1;
  return count;
}

/** Build a board from a sparse map (tests, puzzles): `{ 0: 'l', 9: 'D' }`. */
export function boardFrom(pieces: Record<number, DamaCell>): DamaBoard {
  const cells: string[] = Array.from({ length: 64 }, () => EMPTY);
  for (const [square, cell] of Object.entries(pieces)) {
    const index = Number(square);
    if (!isDarkSquare(index)) throw new Error(`DAMA_LIGHT_SQUARE_${index}`);
    cells[index] = cell;
  }
  return cells.join('');
}

/** Algebraic name, e.g. 0 → "a1" (debugging and logs). */
export const squareName = (square: number): string =>
  `${String.fromCharCode(97 + colOf(square))}${rowOf(square) + 1}`;

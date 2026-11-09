import { DamaCell, DamaColor, boardFrom, countPieces, initialBoard } from '../domain';
import { applyMove, legalMoves, movableSquares } from './dama.moves';

/** "c3" → square index (a1 = 0, row-major from Light's side). */
const sq = (name: string): number => (Number(name.slice(1)) - 1) * 8 + (name.charCodeAt(0) - 97);
const board = (pieces: Record<string, DamaCell>) =>
  boardFrom(Object.fromEntries(Object.entries(pieces).map(([name, cell]) => [sq(name), cell])));
const paths = (moves: { path: number[] }[]) => moves.map((move) => move.path).sort();

describe('Dama moves (DAMA_ET_V1)', () => {
  it('starts with 12 men each and 7 opening moves per side', () => {
    const start = initialBoard();
    expect(countPieces(start, DamaColor.LIGHT)).toBe(12);
    expect(countPieces(start, DamaColor.DARK)).toBe(12);
    expect(legalMoves(start, DamaColor.LIGHT)).toHaveLength(7);
    expect(legalMoves(start, DamaColor.DARK)).toHaveLength(7);
  });

  it('a man steps one square diagonally forward only', () => {
    const light = legalMoves(board({ c3: 'l' }), DamaColor.LIGHT);
    expect(paths(light)).toEqual(paths([{ path: [sq('c3'), sq('b4')] }, { path: [sq('c3'), sq('d4')] }]));
    const dark = legalMoves(board({ c3: 'd' }), DamaColor.DARK);
    expect(paths(dark)).toEqual(paths([{ path: [sq('c3'), sq('b2')] }, { path: [sq('c3'), sq('d2')] }]));
  });

  it('capturing is compulsory', () => {
    const moves = legalMoves(board({ c3: 'l', a3: 'l', d4: 'd' }), DamaColor.LIGHT);
    expect(moves).toEqual([{ path: [sq('c3'), sq('e5')], captured: [sq('d4')] }]);
    expect(movableSquares(moves)).toEqual([sq('c3')]);
  });

  it('a man may capture backwards', () => {
    const moves = legalMoves(board({ e5: 'l', d4: 'd' }), DamaColor.LIGHT);
    expect(moves).toEqual([{ path: [sq('e5'), sq('c3')], captured: [sq('d4')] }]);
  });

  it('only the sequence capturing the most pieces is legal', () => {
    const moves = legalMoves(board({ c3: 'l', a5: 'l', d4: 'd', f6: 'd', b6: 'd' }), DamaColor.LIGHT);
    // a5xc7 (1) and c3xe5 (1) lose to c3xe5xg7 (2)
    expect(moves).toEqual([{ path: [sq('c3'), sq('e5'), sq('g7')], captured: [sq('d4'), sq('f6')] }]);
  });

  it('equal maximum captures are all offered', () => {
    const moves = legalMoves(board({ c3: 'l', b4: 'd', d4: 'd' }), DamaColor.LIGHT);
    expect(paths(moves)).toEqual(paths([{ path: [sq('c3'), sq('a5')] }, { path: [sq('c3'), sq('e5')] }]));
  });

  it('a king flies: slides any distance', () => {
    const moves = legalMoves(board({ d4: 'L' }), DamaColor.LIGHT);
    expect(moves).toHaveLength(13); // full diagonals through d4
  });

  it('a king captures from distance and may land on any empty square beyond', () => {
    const moves = legalMoves(board({ a1: 'L', d4: 'd' }), DamaColor.LIGHT);
    expect(paths(moves)).toEqual(paths(['e5', 'f6', 'g7', 'h8'].map((to) => ({ path: [sq('a1'), sq(to)] }))));
    expect(moves.every((move) => move.captured[0] === sq('d4'))).toBe(true);
  });

  it('a king must choose the landing square that continues the capture', () => {
    const moves = legalMoves(board({ a1: 'L', d4: 'd', e7: 'd' }), DamaColor.LIGHT);
    expect(moves).toEqual([{ path: [sq('a1'), sq('f6'), sq('d8')], captured: [sq('d4'), sq('e7')] }]);
  });

  it('a piece cannot be jumped twice (captured pieces stay until the move ends)', () => {
    const moves = legalMoves(board({ a1: 'L', b2: 'd' }), DamaColor.LIGHT);
    expect(moves).toHaveLength(6); // c3..h8, one capture each, no loop back over b2
    expect(moves.every((move) => move.captured.length === 1)).toBe(true);
  });

  it('a captured piece blocks the line for the rest of the move', () => {
    // After a1xd4 → e5, the way back down to b2 runs into d4 (still on the board).
    const moves = legalMoves(board({ a1: 'L', d4: 'd', b2: 'l', c5: 'd' }), DamaColor.LIGHT);
    for (const move of moves) expect(new Set(move.captured).size).toBe(move.captured.length);
  });

  it('a man passing the far row mid-capture is not crowned', () => {
    const moves = legalMoves(board({ d6: 'l', e7: 'd', g7: 'd' }), DamaColor.LIGHT);
    expect(moves).toEqual([{ path: [sq('d6'), sq('f8'), sq('h6')], captured: [sq('e7'), sq('g7')] }]);
    const after = applyMove(board({ d6: 'l', e7: 'd', g7: 'd' }), moves[0]);
    expect(after.promoted).toBe(false);
    expect(after.board[sq('h6')]).toBe('l');
    expect(countPieces(after.board, DamaColor.DARK)).toBe(0);
  });

  it('a man that ends on the far row is crowned', () => {
    const after = applyMove(board({ c7: 'l' }), { path: [sq('c7'), sq('d8')], captured: [] });
    expect(after).toEqual({ board: board({ d8: 'L' }), promoted: true });
    const dark = applyMove(board({ b2: 'd' }), { path: [sq('b2'), sq('a1')], captured: [] });
    expect(dark.board[sq('a1')]).toBe('D');
  });
});

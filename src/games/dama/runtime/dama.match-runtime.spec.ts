import { DAMA_DRAW_PLIES, DamaCell, DamaPhase, boardFrom } from '../domain';
import { DamaMatchRuntimeState, DamaRuntimeEventType } from './dama.runtime.types';
import { createDamaMatch, currentLegalMoves, executeDamaCommand } from './dama.match-runtime';

const sq = (name: string): number => (Number(name.slice(1)) - 1) * 8 + (name.charCodeAt(0) - 97);
const position = (pieces: Record<string, DamaCell>, patch: Partial<DamaMatchRuntimeState['game']> = {}) => {
  const state = createDamaMatch('m1', 'light', 'dark');
  const board = boardFrom(Object.fromEntries(Object.entries(pieces).map(([name, cell]) => [sq(name), cell])));
  return { game: { ...state.game, board, ...patch } };
};
const move = (state: DamaMatchRuntimeState, playerId: string, path: string[], commandId = 'c1') =>
  executeDamaCommand(state, { type: 'MOVE', commandId, playerId, expectedVersion: state.game.version, path: path.map(sq) });

describe('Dama match runtime', () => {
  it('Light moves first, then the turn passes with the reply moves', () => {
    const start = createDamaMatch('m1', 'light', 'dark');
    expect(start.game.currentPlayerId).toBe('light');
    const result = move(start, 'light', ['c3', 'd4']);
    expect(result.state.game).toMatchObject({ version: 1, currentPlayerId: 'dark', plyCount: 1, pliesSinceProgress: 0 });
    expect(result.events.map((event) => event.type)).toEqual([DamaRuntimeEventType.PIECE_MOVED, DamaRuntimeEventType.TURN_STARTED]);
    expect(result.events[1].legalMoves).toHaveLength(7);
    expect(start.game.version).toBe(0); // input untouched
  });

  it('rejects stale versions, wrong turns and illegal moves', () => {
    const start = createDamaMatch('m1', 'light', 'dark');
    expect(() => executeDamaCommand(start, { type: 'MOVE', commandId: 'c', playerId: 'light', expectedVersion: 3, path: [sq('c3'), sq('d4')] })).toThrow('MATCH_VERSION_CONFLICT');
    expect(() => move(start, 'dark', ['d6', 'c5'])).toThrow('NOT_PLAYER_TURN');
    expect(() => move(start, 'light', ['c3', 'c4'])).toThrow('ILLEGAL_DAMA_MOVE');
    expect(() => move(start, 'stranger', ['c3', 'd4'])).toThrow('PLAYER_NOT_IN_MATCH');
    expect(() => move(position({ c3: 'l', d4: 'd', a3: 'l' }), 'light', ['a3', 'b4'])).toThrow('ILLEGAL_DAMA_MOVE'); // must capture
  });

  it('capturing the last piece wins', () => {
    const result = move(position({ c3: 'l', d4: 'd' }), 'light', ['c3', 'e5']);
    expect(result.state.game).toMatchObject({ phase: DamaPhase.FINISHED, result: 'WIN', finishReason: 'NO_PIECES', winnerOrder: ['light', 'dark'], currentPlayerId: null });
    expect(result.events.at(-1)).toMatchObject({ type: DamaRuntimeEventType.MATCH_FINISHED, result: 'WIN', reason: 'NO_PIECES' });
  });

  it('leaving the opponent without a legal move wins (blocked = loss)', () => {
    const result = move(position({ a5: 'l', c5: 'l', a7: 'd' }), 'light', ['a5', 'b6']);
    expect(result.state.game).toMatchObject({ result: 'WIN', finishReason: 'NO_MOVES', winnerOrder: ['light', 'dark'] });
  });

  it('draws after the no-progress limit; a capture or man move resets it', () => {
    const near = position({ a1: 'L', h2: 'D', c7: 'd' }, { pliesSinceProgress: DAMA_DRAW_PLIES - 1 });
    const drawn = move(near, 'light', ['a1', 'b2']);
    expect(drawn.state.game).toMatchObject({ result: 'DRAW', finishReason: 'DRAW_RULE', winnerOrder: [] });

    const reset = move(position({ a1: 'L', c3: 'l', h8: 'D', h6: 'd' }, { pliesSinceProgress: 10 }), 'light', ['c3', 'd4']);
    expect(reset.state.game.pliesSinceProgress).toBe(0);
  });

  it('resigning gives the opponent the win', () => {
    const result = executeDamaCommand(createDamaMatch('m1', 'light', 'dark'), { type: 'RESIGN', commandId: 'r', playerId: 'dark', expectedVersion: 0 });
    expect(result.state.game).toMatchObject({ result: 'WIN', finishReason: 'RESIGN', winnerOrder: ['light', 'dark'], version: 1 });
    expect(result.events.map((event) => event.type)).toEqual([DamaRuntimeEventType.PLAYER_RESIGNED, DamaRuntimeEventType.MATCH_FINISHED]);
    expect(() => executeDamaCommand(result.state, { type: 'RESIGN', commandId: 'r2', playerId: 'light', expectedVersion: 1 })).toThrow('MATCH_NOT_PLAYING');
    expect(currentLegalMoves(result.state)).toEqual([]);
  });
});

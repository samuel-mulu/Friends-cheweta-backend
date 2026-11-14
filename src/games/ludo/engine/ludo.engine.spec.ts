import {
  LUDO_BASE_PROGRESS,
  LudoRulesVersion,
  LudoTokenState,
  boardFor,
  createInitialLudoState,
} from '../domain';
import { LudoEngine, LudoMoveKind } from './index';

function state2(version: LudoRulesVersion = 'LUDO_CLASSIC_V3') {
  return createInitialLudoState('match-test', ['red-user', 'yellow-user'], version);
}

describe('LudoEngine B7', () => {
  const engine = new LudoEngine();

  it('deploys from base only with a six', () => {
    const state = state2();
    expect(engine.getLegalMoves(state, 'red-user', 5)).toHaveLength(0);
    const moves = engine.getLegalMoves(state, 'red-user', 6);
    expect(moves).toHaveLength(4);
    expect(moves.every((move) => move.kind === LudoMoveKind.DEPLOY && move.toProgress === 0)).toBe(true);
    expect(moves[0].path).toEqual([-1, 0]);
  });

  it('moves an active token and increments immutable state version', () => {
    const state = state2();
    state.players[0].tokens[0].state = LudoTokenState.ACTIVE;
    state.players[0].tokens[0].progress = 10;

    const { state: next, resolution } = engine.move(state, 'red-user', 'RED-1', 4);
    expect(next.players[0].tokens[0].progress).toBe(14);
    expect(next.version).toBe(1);
    expect(state.players[0].tokens[0].progress).toBe(10);
    expect(resolution.stateVersionBefore).toBe(0);
    expect(resolution.stateVersionAfter).toBe(1);
    expect(resolution.move.path).toEqual([10, 11, 12, 13, 14]);
  });

  it('captures one opponent token on a non-safe shared square', () => {
    const state = state2();
    state.players[0].tokens[0].state = LudoTokenState.ACTIVE;
    state.players[0].tokens[0].progress = 5; // red global 5
    state.players[1].tokens[0].state = LudoTokenState.ACTIVE;
    state.players[1].tokens[0].progress = 33; // yellow start 26 + 33 = global 7

    const { state: next, resolution } = engine.move(state, 'red-user', 'RED-1', 2);
    expect(next.players[0].tokens[0].progress).toBe(7);
    expect(next.players[1].tokens[0].state).toBe(LudoTokenState.BASE);
    expect(next.players[1].tokens[0].progress).toBe(LUDO_BASE_PROGRESS);
    expect(resolution.capturedTokenIds).toEqual(['YELLOW-1']);
  });

  it('does not capture an opponent on a safe square', () => {
    const state = state2();
    state.players[0].tokens[0].state = LudoTokenState.ACTIVE;
    state.players[0].tokens[0].progress = 6; // red -> global 6
    state.players[1].tokens[0].state = LudoTokenState.ACTIVE;
    state.players[1].tokens[0].progress = 34; // yellow -> global 8 safe

    const move = engine.getLegalMoves(state, 'red-user', 2).find((item) => item.tokenId === 'RED-1');
    expect(move?.destinationGlobalSquare).toBe(8);
    expect(move?.capturedTokenIds).toEqual([]);

    const { state: next } = engine.move(state, 'red-user', 'RED-1', 2);
    expect(next.players[1].tokens[0].state).toBe(LudoTokenState.ACTIVE);
  });

  it('cannot pass through an opponent blockade', () => {
    const state = state2();
    state.players[0].tokens[0].state = LudoTokenState.ACTIVE;
    state.players[0].tokens[0].progress = 4;

    for (const token of state.players[1].tokens.slice(0, 2)) {
      token.state = LudoTokenState.ACTIVE;
      token.progress = 32; // yellow global 6
    }

    const red1 = engine.getLegalMoves(state, 'red-user', 4).find((move) => move.tokenId === 'RED-1');
    expect(red1).toBeUndefined();
  });

  it('cannot land on an opponent blockade, including a safe square', () => {
    const state = state2();
    state.players[0].tokens[0].state = LudoTokenState.ACTIVE;
    state.players[0].tokens[0].progress = 6;

    for (const token of state.players[1].tokens.slice(0, 2)) {
      token.state = LudoTokenState.ACTIVE;
      token.progress = 34; // yellow global 8, safe but blocked by same-owner pair
    }

    expect(engine.getLegalTokenIds(state, 'red-user', 2)).not.toContain('RED-1');
  });

  it('cannot create an own blockade on a safe square already shared with an opponent', () => {
    const state = state2();
    state.players[0].tokens[0].state = LudoTokenState.ACTIVE;
    state.players[0].tokens[0].progress = 8; // red global 8 safe
    state.players[0].tokens[1].state = LudoTokenState.ACTIVE;
    state.players[0].tokens[1].progress = 6;
    state.players[1].tokens[0].state = LudoTokenState.ACTIVE;
    state.players[1].tokens[0].progress = 34; // yellow global 8 safe

    expect(engine.getLegalTokenIds(state, 'red-user', 2)).not.toContain('RED-2');
  });

  it('allows the blockade owner to pass their own blockade', () => {
    const state = state2();
    for (const token of state.players[0].tokens.slice(0, 2)) {
      token.state = LudoTokenState.ACTIVE;
      token.progress = 4;
    }
    const legal = engine.getLegalTokenIds(state, 'red-user', 3);
    expect(legal).toContain('RED-1');
    expect(legal).toContain('RED-2');
  });

  it('V3: turns into the private home path right after the door square (progress 50)', () => {
    const state = state2('LUDO_CLASSIC_V3');
    state.players[0].tokens[0].state = LudoTokenState.ACTIVE;
    state.players[0].tokens[0].progress = 50;

    const one = engine.getLegalMoves(state, 'red-user', 1).find((m) => m.tokenId === 'RED-1');
    expect(one?.toProgress).toBe(51);
    expect(one?.toState).toBe(LudoTokenState.HOME_PATH);
    expect(one?.destinationGlobalSquare).toBeNull(); // not a shared square any more

    const { state: next } = engine.move(state, 'red-user', 'RED-1', 3);
    expect(next.players[0].tokens[0].progress).toBe(53);
    expect(next.players[0].tokens[0].state).toBe(LudoTokenState.HOME_PATH);
  });

  it('V2 (legacy, stored matches): still walks one square past the door before turning in', () => {
    const state = state2('LUDO_CLASSIC_V2');
    state.players[0].tokens[0].state = LudoTokenState.ACTIVE;
    state.players[0].tokens[0].progress = 50;

    const one = engine.getLegalMoves(state, 'red-user', 1).find((m) => m.tokenId === 'RED-1');
    expect(one?.toProgress).toBe(51);
    expect(one?.toState).toBe(LudoTokenState.ACTIVE);
    expect(one?.destinationGlobalSquare).toBe(51);

    const { state: next } = engine.move(state, 'red-user', 'RED-1', 3);
    expect(next.players[0].tokens[0].progress).toBe(53);
    expect(next.players[0].tokens[0].state).toBe(LudoTokenState.HOME_PATH);
  });

  it.each(['LUDO_CLASSIC_V2', 'LUDO_CLASSIC_V3'] as const)('%s: requires an exact roll to finish', (version) => {
    const board = boardFor(version);
    const state = state2(version);
    state.players[0].tokens[0].state = LudoTokenState.HOME_PATH;
    state.players[0].tokens[0].progress = board.finish - 2;

    expect(engine.getLegalTokenIds(state, 'red-user', 3)).not.toContain('RED-1');
    expect(engine.getLegalTokenIds(state, 'red-user', 2)).toContain('RED-1');

    const { state: next } = engine.move(state, 'red-user', 'RED-1', 2);
    expect(next.players[0].tokens[0].progress).toBe(board.finish);
    expect(next.players[0].tokens[0].state).toBe(LudoTokenState.FINISHED);
  });

  it('never moves a finished token', () => {
    const state = state2();
    state.players[0].tokens[0].state = LudoTokenState.FINISHED;
    state.players[0].tokens[0].progress = boardFor(state.rulesVersion).finish;
    expect(engine.getLegalTokenIds(state, 'red-user', 6)).not.toContain('RED-1');
  });
});

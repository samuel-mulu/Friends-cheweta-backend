import {
  LUDO_START_INDEX,
  LudoColor,
  LudoRulesVersion,
  LudoTokenState,
  assertValidLudoState,
  boardFor,
  createInitialLudoState,
} from '../domain';
import { LudoEngine } from './index';

/**
 * Regression guard for the "token escaped its home" bug: for every colour and
 * every position near the door, a move must land on the shared track at or
 * before the door, inside the private home column, or exactly on the finish —
 * never on a shared square past the door, and never past the finish.
 */
const engine = new LudoEngine();
const COLORS = [LudoColor.RED, LudoColor.GREEN, LudoColor.YELLOW, LudoColor.BLUE];
const USERS = ['u-red', 'u-green', 'u-yellow', 'u-blue'];

function stateWithToken(version: LudoRulesVersion, colorIndex: number, progress: number) {
  const board = boardFor(version);
  const state = createInitialLudoState('home-entry', USERS, version);
  const token = state.players[colorIndex].tokens[0];
  token.progress = progress;
  token.state =
    progress >= board.finish
      ? LudoTokenState.FINISHED
      : progress >= board.homeStart
        ? LudoTokenState.HOME_PATH
        : LudoTokenState.ACTIVE;
  return { state, token, board };
}

describe.each(['LUDO_CLASSIC_V3', 'LUDO_CLASSIC_V2'] as const)('home entry under %s', (version) => {
  const board = boardFor(version);

  describe.each(COLORS.map((color, index) => [color, index] as const))('%s', (color, colorIndex) => {
    const cases: Array<[number, number]> = [];
    for (let progress = 44; progress <= board.homeLast; progress += 1) {
      for (let dice = 1; dice <= 6; dice += 1) cases.push([progress, dice]);
    }

    it.each(cases)('from %i with a %i', (progress, dice) => {
      const { state, token } = stateWithToken(version, colorIndex, progress);
      const move = engine.getLegalMoves(state, USERS[colorIndex], dice).find((m) => m.tokenId === token.id);
      const destination = progress + dice;

      if (destination > board.finish) {
        expect(move).toBeUndefined(); // overshoot is never offered
        return;
      }

      expect(move).toBeDefined();
      expect(move!.toProgress).toBe(destination);
      expect(move!.path).toEqual(Array.from({ length: dice + 1 }, (_, i) => progress + i));

      if (destination <= board.trackLast) {
        expect(move!.toState).toBe(LudoTokenState.ACTIVE);
        expect(move!.destinationGlobalSquare).toBe((LUDO_START_INDEX[color] + destination) % 52);
      } else if (destination < board.finish) {
        expect(move!.toState).toBe(LudoTokenState.HOME_PATH);
        expect(move!.destinationGlobalSquare).toBeNull();
      } else {
        expect(move!.toState).toBe(LudoTokenState.FINISHED);
        expect(move!.destinationGlobalSquare).toBeNull();
      }

      const { state: next } = engine.move(state, USERS[colorIndex], token.id, dice);
      expect(() => assertValidLudoState(next)).not.toThrow();
    });
  });

  it('a colour visits exactly lapSquares shared squares before its home column', () => {
    const { state } = stateWithToken(version, 0, 0);
    const visited = new Set<number>();
    for (let progress = 0; progress <= board.trackLast; progress += 1) {
      visited.add((LUDO_START_INDEX[LudoColor.RED] + progress) % 52);
    }
    expect(visited.size).toBe(board.lapSquares);
    expect(state.rulesVersion).toBe(version);
  });
});

describe('V3 specifically never puts a token on the square before its own start', () => {
  it.each(COLORS.map((color, index) => [color, index] as const))('%s', (color, colorIndex) => {
    const forbidden = (LUDO_START_INDEX[color] + 51) % 52;
    for (let dice = 1; dice <= 6; dice += 1) {
      const { state, token } = stateWithToken('LUDO_CLASSIC_V3', colorIndex, 50);
      const move = engine.getLegalMoves(state, USERS[colorIndex], dice).find((m) => m.tokenId === token.id);
      expect(move?.destinationGlobalSquare ?? -1).not.toBe(forbidden);
    }
  });
});

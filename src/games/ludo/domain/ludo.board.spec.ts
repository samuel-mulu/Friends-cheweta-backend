import {
  LUDO_START_INDEX,
  boardFor,
  canFinishWithRoll,
  isSafeGlobalSquare,
  progressPath,
  toGlobalTrackIndex,
} from './ludo.board';
import { LUDO_RULES_VERSIONS } from './ludo.rules';
import { createInitialLudoState } from './ludo.state';
import { LudoColor, LudoTokenState } from './ludo.types';
import { assertValidLudoState } from './ludo.invariants';

const COLORS = [LudoColor.RED, LudoColor.GREEN, LudoColor.YELLOW, LudoColor.BLUE];

describe('Ludo board geometry', () => {
  it('maps player-relative progress onto the shared 52-cell track', () => {
    for (const version of LUDO_RULES_VERSIONS) {
      const board = boardFor(version);
      expect(toGlobalTrackIndex(board, LudoColor.RED, 0)).toBe(0);
      expect(toGlobalTrackIndex(board, LudoColor.GREEN, 0)).toBe(13);
      expect(toGlobalTrackIndex(board, LudoColor.YELLOW, 26)).toBe(0);
      expect(toGlobalTrackIndex(board, LudoColor.BLUE, 13)).toBe(0);
    }
  });

  it('uses the frozen Friends safe-square map', () => {
    expect(isSafeGlobalSquare(0)).toBe(true);
    expect(isSafeGlobalSquare(8)).toBe(true);
    expect(isSafeGlobalSquare(9)).toBe(false);
  });

  describe('standard board (V3): a colour leaves the track right after its door square', () => {
    const board = boardFor('LUDO_CLASSIC_V3');

    it('resolves thresholds 0..50 track, 51..55 home, 56 finish', () => {
      expect(board).toMatchObject({ trackLast: 50, homeStart: 51, homeLast: 55, finish: 56 });
    });

    it('progress 50 is the square in front of the home column and 51 is no longer shared', () => {
      for (const color of COLORS) {
        // The door square sits two cells before the colour's own start on the loop.
        expect(toGlobalTrackIndex(board, color, 50)).toBe((LUDO_START_INDEX[color] + 50) % 52);
        expect(() => toGlobalTrackIndex(board, color, 51)).toThrow(RangeError);
      }
    });

    it('requires an exact roll at the finish boundary', () => {
      expect(canFinishWithRoll(board, 55, 1)).toBe(true);
      expect(canFinishWithRoll(board, 55, 2)).toBe(false);
      expect(canFinishWithRoll(board, 50, 6)).toBe(true);
      expect(canFinishWithRoll(board, 56, 1)).toBe(false);
    });
  });

  describe('legacy board (V1/V2) keeps the stored 52-square lap', () => {
    it.each(['LUDO_CLASSIC_V1', 'LUDO_CLASSIC_V2'] as const)('%s', (version) => {
      const board = boardFor(version);
      expect(board).toMatchObject({ trackLast: 51, homeStart: 52, homeLast: 56, finish: 57 });
      for (const color of COLORS) {
        // One square past the door: the cell just before the colour's own start.
        expect(toGlobalTrackIndex(board, color, 51)).toBe((LUDO_START_INDEX[color] + 51) % 52);
      }
      expect(canFinishWithRoll(board, 55, 2)).toBe(true);
      expect(canFinishWithRoll(board, 55, 3)).toBe(false);
      expect(canFinishWithRoll(board, 57, 1)).toBe(false);
    });
  });

  it('lists every square a move visits, with a yard exit as a single hop', () => {
    expect(progressPath(-1, 0)).toEqual([-1, 0]);
    expect(progressPath(10, 14)).toEqual([10, 11, 12, 13, 14]);
    expect(progressPath(50, 51)).toEqual([50, 51]);
  });

  it('creates a two-player game on opposite colors with four base tokens each', () => {
    const state = createInitialLudoState('match-1', ['user-a', 'user-b']);
    expect(state.players.map((player) => player.color)).toEqual([LudoColor.RED, LudoColor.YELLOW]);
    expect(state.players.every((player) => player.tokens.length === 4)).toBe(true);
    expect(state.players.flatMap((player) => player.tokens).every((token) => token.state === LudoTokenState.BASE)).toBe(true);
    expect(() => assertValidLudoState(state)).not.toThrow();
  });

  it('validates token ranges against the state\'s own rules version', () => {
    const v3 = createInitialLudoState('m', ['a', 'b'], 'LUDO_CLASSIC_V3');
    v3.players[0].tokens[0].state = LudoTokenState.ACTIVE;
    v3.players[0].tokens[0].progress = 51; // home cell under V3, not track
    expect(() => assertValidLudoState(v3)).toThrow();
    v3.players[0].tokens[0].state = LudoTokenState.HOME_PATH;
    expect(() => assertValidLudoState(v3)).not.toThrow();

    const v2 = createInitialLudoState('m', ['a', 'b'], 'LUDO_CLASSIC_V2');
    v2.players[0].tokens[0].state = LudoTokenState.ACTIVE;
    v2.players[0].tokens[0].progress = 51;
    expect(() => assertValidLudoState(v2)).not.toThrow();
  });
});

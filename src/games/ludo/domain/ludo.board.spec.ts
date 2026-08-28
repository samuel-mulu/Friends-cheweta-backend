import {
  LUDO_FINISH_PROGRESS,
  canFinishWithRoll,
  isSafeGlobalSquare,
  toGlobalTrackIndex,
} from './ludo.board';
import { createInitialLudoState } from './ludo.state';
import { LudoColor, LudoTokenState } from './ludo.types';
import { assertValidLudoState } from './ludo.invariants';

describe('LUDO_CLASSIC_V1 domain model', () => {
  it('maps player-relative progress onto the shared 52-cell track', () => {
    expect(toGlobalTrackIndex(LudoColor.RED, 0)).toBe(0);
    expect(toGlobalTrackIndex(LudoColor.GREEN, 0)).toBe(13);
    expect(toGlobalTrackIndex(LudoColor.YELLOW, 26)).toBe(0);
    expect(toGlobalTrackIndex(LudoColor.BLUE, 13)).toBe(0);
  });

  it('uses the frozen Friends safe-square map', () => {
    expect(isSafeGlobalSquare(0)).toBe(true);
    expect(isSafeGlobalSquare(8)).toBe(true);
    expect(isSafeGlobalSquare(9)).toBe(false);
  });

  it('requires an exact-or-lower roll at the finish boundary', () => {
    expect(canFinishWithRoll(55, 2)).toBe(true);
    expect(canFinishWithRoll(55, 3)).toBe(false);
    expect(canFinishWithRoll(LUDO_FINISH_PROGRESS, 1)).toBe(false);
  });

  it('creates a two-player game on opposite colors with four base tokens each', () => {
    const state = createInitialLudoState('match-1', ['user-a', 'user-b']);
    expect(state.players.map((player) => player.color)).toEqual([LudoColor.RED, LudoColor.YELLOW]);
    expect(state.players.every((player) => player.tokens.length === 4)).toBe(true);
    expect(state.players.flatMap((player) => player.tokens).every((token) => token.state === LudoTokenState.BASE)).toBe(true);
    expect(() => assertValidLudoState(state)).not.toThrow();
  });
});

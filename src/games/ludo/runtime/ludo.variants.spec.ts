import { FixedDiceProvider } from '../dice';
import {
  LudoMatchPhase,
  LudoRulesVersion,
  LudoTokenState,
  LudoTurnPhase,
  assertValidLudoState,
  boardFor,
  createInitialLudoState,
  rulesFor,
} from '../domain';
import { LudoEngine } from '../engine';
import { LudoMatchRuntime } from './ludo.match-runtime';
import { LudoRuntimeEventType } from './ludo.runtime.types';

/**
 * The three Ludo types: መመለስ ያለበት (LUDO_CLASSIC_V3), መመለስ የሌለበት
 * (LUDO_NO_CAPTURE_V1) and መመለስ የረሳ ይሸነፋል (LUDO_MISSED_CAPTURE_V1).
 *
 * RED = p1 (start square 0); YELLOW = p2 (start square 26). RED at progress
 * 10 rolling 2 lands on global 12, where YELLOW at progress 38 stands (not safe).
 */
function position(version: LudoRulesVersion, red: number[], yellow: number[]) {
  const game = createInitialLudoState('m1', ['p1', 'p2'], version);
  const board = boardFor(version);
  game.phase = LudoMatchPhase.PLAYING;
  game.turnPhase = LudoTurnPhase.WAITING_FOR_ROLL;
  game.currentPlayerId = 'p1';
  const place = (playerIndex: number, progress: number[]) =>
    game.players[playerIndex].tokens.forEach((token, i) => {
      const p = progress[i] ?? -1;
      token.progress = p;
      token.state =
        p < 0
          ? LudoTokenState.BASE
          : p >= board.finish
            ? LudoTokenState.FINISHED
            : p >= board.homeStart
              ? LudoTokenState.HOME_PATH
              : LudoTokenState.ACTIVE;
    });
  place(0, red);
  place(1, yellow);
  return game;
}

function runtime(version: LudoRulesVersion, red: number[], yellow: number[], dice: number[]) {
  return LudoMatchRuntime.restore(
    {
      game: position(version, red, yellow),
      startingRoll: { round: 1, candidatePlayerIds: ['p1', 'p2'], rolls: {} },
      resignedPlayerIds: [],
    },
    new FixedDiceProvider(dice),
  );
}

const roll = (r: LudoMatchRuntime) =>
  r.execute({
    type: 'ROLL_DICE',
    commandId: 'roll',
    playerId: 'p1',
    expectedVersion: r.getState().game.version,
  });
const move = (r: LudoMatchRuntime, tokenId: string) =>
  r.execute({
    type: 'MOVE_TOKEN',
    commandId: `move-${tokenId}`,
    playerId: 'p1',
    tokenId,
    expectedVersion: r.getState().game.version,
  });
const types = (events: Array<{ type: LudoRuntimeEventType }>) => events.map((e) => e.type);
const yellowToken = (r: LudoMatchRuntime) => r.getState().game.players[1].tokens[0];

describe('Ludo types (rules registry)', () => {
  it('only the capture rules differ from the classic V3', () => {
    const classic = rulesFor('LUDO_CLASSIC_V3');
    expect(rulesFor('LUDO_NO_CAPTURE_V1')).toEqual({
      ...classic,
      version: 'LUDO_NO_CAPTURE_V1',
      captureEnabled: false,
      captureGrantsExtraRoll: false,
    });
    expect(rulesFor('LUDO_MISSED_CAPTURE_V1')).toEqual({
      ...classic,
      version: 'LUDO_MISSED_CAPTURE_V1',
      missedCaptureLoses: true,
    });
    expect(classic).toMatchObject({ captureEnabled: true, missedCaptureLoses: false });
  });
});

describe('መመለስ ያለበት (classic V3): landing on a lone opponent sends it home', () => {
  it('captures', () => {
    const r = runtime('LUDO_CLASSIC_V3', [10, 20], [38], [2]);
    roll(r);
    expect(types(move(r, 'RED-1').events)).toContain(LudoRuntimeEventType.TOKEN_CAPTURED);
    expect(yellowToken(r).state).toBe(LudoTokenState.BASE);
  });

  it('opposing tokens may not share a non-safe square', () => {
    const game = position('LUDO_CLASSIC_V3', [12], [38]);
    expect(() => assertValidLudoState(game)).toThrow(/cannot coexist/);
  });
});

describe('መመለስ የሌለበት (no captures)', () => {
  it('landing on an opponent shares the square; nobody goes home', () => {
    const r = runtime('LUDO_NO_CAPTURE_V1', [10, 20], [38], [2]);
    const rolled = roll(r);
    const ready = rolled.events.find((e) => e.type === LudoRuntimeEventType.LEGAL_MOVES_READY);
    expect(ready?.legalMoves?.every((m) => m.captures.length === 0)).toBe(true);

    const result = move(r, 'RED-1');
    expect(types(result.events)).not.toContain(LudoRuntimeEventType.TOKEN_CAPTURED);
    expect(r.getState().game.players[0].tokens[0].progress).toBe(12);
    expect(yellowToken(r)).toMatchObject({ progress: 38, state: LudoTokenState.ACTIVE });
    // Sharing earns no extra roll (nothing was captured): the turn passes.
    expect(r.getState().game.currentPlayerId).toBe('p2');
  });

  it('opposing tokens may share any square', () => {
    expect(() => assertValidLudoState(position('LUDO_NO_CAPTURE_V1', [12], [38]))).not.toThrow();
  });

  it('a blockade still cannot form on top of an opponent', () => {
    // RED-2 already shares global 12 with YELLOW; RED-1 joining it would make a
    // blockade over the opponent, so only RED-2 can move (and is auto-played).
    const r = runtime('LUDO_NO_CAPTURE_V1', [10, 12], [38], [2]);
    roll(r);
    const tokens = r.getState().game.players[0].tokens;
    expect(tokens[0].progress).toBe(10);
    expect(tokens[1].progress).toBe(14);
  });
});

describe('መመለስ የረሳ ይሸነፋል (forget to send back and you lose)', () => {
  it('moving another token while a capture is possible forfeits the match', () => {
    const r = runtime('LUDO_MISSED_CAPTURE_V1', [10, 20], [38], [2]);
    roll(r);
    const result = move(r, 'RED-2');
    expect(types(result.events)).toEqual([
      LudoRuntimeEventType.CAPTURE_MISSED,
      LudoRuntimeEventType.MATCH_FINISHED,
    ]);
    const missed = result.events[0];
    expect(missed).toMatchObject({ playerId: 'p1', tokenId: 'RED-2' });
    const state = r.getState();
    expect(state.game.phase).toBe(LudoMatchPhase.FINISHED);
    expect(state.game.winnerOrder).toEqual(['p2', 'p1']);
    expect(state.missedCapturePlayerIds).toEqual(['p1']);
    // The losing move is not played; like any player who is out, the
    // forfeiting player's board tokens go back to the yard.
    expect(types(result.events)).not.toContain(LudoRuntimeEventType.TOKEN_MOVED);
    expect(missed.tokenIds).toEqual(['RED-1', 'RED-2']);
    expect(yellowToken(r)).toMatchObject({ progress: 38, state: LudoTokenState.ACTIVE });
  });

  it('taking the capture plays on normally', () => {
    const r = runtime('LUDO_MISSED_CAPTURE_V1', [10, 20], [38], [2]);
    roll(r);
    expect(types(move(r, 'RED-1').events)).toContain(LudoRuntimeEventType.TOKEN_CAPTURED);
    expect(r.getState().game.phase).toBe(LudoMatchPhase.PLAYING);
  });

  it('with no capture available any move is fine', () => {
    const r = runtime('LUDO_MISSED_CAPTURE_V1', [10, 20], [45], [2]);
    roll(r);
    expect(types(move(r, 'RED-2').events)).not.toContain(LudoRuntimeEventType.CAPTURE_MISSED);
    expect(r.getState().game.phase).toBe(LudoMatchPhase.PLAYING);
  });

  it('moves played for someone (timeouts, bots) always take the capture', () => {
    const engine = new LudoEngine();
    const missed = position('LUDO_MISSED_CAPTURE_V1', [10, 20], [38]);
    expect(engine.getChoosableMoves(missed, 'p1', 2).map((m) => m.tokenId)).toEqual(['RED-1']);
    const classic = position('LUDO_CLASSIC_V3', [10, 20], [38]);
    expect(engine.getChoosableMoves(classic, 'p1', 2).map((m) => m.tokenId)).toEqual([
      'RED-1',
      'RED-2',
    ]);
  });
});

import { FixedDiceProvider } from '../dice';
import {
  LudoMatchPhase,
  LudoRulesVersion,
  LudoTokenState,
  LudoTurnPhase,
  createInitialLudoState,
  rulesFor,
} from '../domain';
import { LudoMatchRuntime } from './ludo.match-runtime';
import { LudoRuntimeEventType } from './ludo.runtime.types';

/** RED = p1 (start square 0); YELLOW = p2 (start square 26). */
function setup(version: LudoRulesVersion, red: number[], yellow: number[], dice: number[]) {
  const game = createInitialLudoState('m1', ['p1', 'p2'], version);
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
          : p >= 57
            ? LudoTokenState.FINISHED
            : p >= 52
              ? LudoTokenState.HOME_PATH
              : LudoTokenState.ACTIVE;
    });
  place(0, red);
  place(1, yellow);
  return LudoMatchRuntime.restore(
    {
      game,
      startingRoll: { round: 1, candidatePlayerIds: ['p1', 'p2'], rolls: {} },
      resignedPlayerIds: [],
    },
    new FixedDiceProvider(dice),
  );
}

const roll = (runtime: LudoMatchRuntime, version: number) =>
  runtime.execute({
    type: 'ROLL_DICE',
    commandId: `roll-${version}`,
    playerId: 'p1',
    expectedVersion: version,
  });
const move = (runtime: LudoMatchRuntime, tokenId: string, version: number) =>
  runtime.execute({
    type: 'MOVE_TOKEN',
    commandId: `move-${version}`,
    playerId: 'p1',
    tokenId,
    expectedVersion: version,
  });
const types = (events: Array<{ type: LudoRuntimeEventType }>) => events.map((e) => e.type);

describe('rules registry', () => {
  it('V2 = V1 board with popular extra-roll and auto-move rules', () => {
    expect(rulesFor('LUDO_CLASSIC_V2')).toMatchObject({
      captureGrantsExtraRoll: true,
      finishGrantsExtraRoll: true,
      autoMoveSingleLegal: true,
    });
    expect(rulesFor('LUDO_CLASSIC_V1')).toMatchObject({
      captureGrantsExtraRoll: false,
      finishGrantsExtraRoll: false,
      autoMoveSingleLegal: false,
    });
    expect(() => rulesFor('NOPE')).toThrow();
  });
});

describe('popular rules (V2)', () => {
  // RED-1 at 10 captures YELLOW at global 12 (yellow progress 38) with a 2.
  // RED-2 at 20 keeps a second legal move so nothing is auto-played.
  it('a capture earns an extra roll', () => {
    const runtime = setup('LUDO_CLASSIC_V2', [10, 20], [38], [2]);
    roll(runtime, 0);
    const result = move(runtime, 'RED-1', 1);
    expect(types(result.events)).toEqual(
      expect.arrayContaining([
        LudoRuntimeEventType.TOKEN_CAPTURED,
        LudoRuntimeEventType.EXTRA_ROLL_GRANTED,
      ]),
    );
    expect(runtime.getState().game.currentPlayerId).toBe('p1');
    expect(runtime.getState().game.turnPhase).toBe(LudoTurnPhase.WAITING_FOR_ROLL);
  });

  it('bringing a token home earns an extra roll', () => {
    const runtime = setup('LUDO_CLASSIC_V2', [55, 20], [], [2]);
    roll(runtime, 0);
    const result = move(runtime, 'RED-1', 1);
    expect(types(result.events)).toEqual(
      expect.arrayContaining([
        LudoRuntimeEventType.TOKEN_FINISHED,
        LudoRuntimeEventType.EXTRA_ROLL_GRANTED,
      ]),
    );
    expect(runtime.getState().game.currentPlayerId).toBe('p1');
  });

  it('a single legal move is played automatically in the same command', () => {
    const runtime = setup('LUDO_CLASSIC_V2', [20], [], [3]);
    const result = roll(runtime, 0);
    expect(types(result.events)).not.toContain(LudoRuntimeEventType.LEGAL_MOVES_READY);
    expect(types(result.events)).toEqual(
      expect.arrayContaining([
        LudoRuntimeEventType.DICE_ROLLED,
        LudoRuntimeEventType.TOKEN_MOVED,
        LudoRuntimeEventType.TURN_STARTED,
      ]),
    );
    expect(runtime.getState().game.players[0].tokens[0].progress).toBe(23);
    expect(runtime.getState().game.currentPlayerId).toBe('p2');
    // Versions stay strictly sequential for clients.
    const versions = result.events.map((e) => e.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
  });

  it('with several choices, LEGAL_MOVES_READY carries a landing preview', () => {
    // RED-1 6 -> 8 (safe star), RED-2 10 -> 12 (captures yellow at global 12).
    const runtime = setup('LUDO_CLASSIC_V2', [6, 10], [38], [2]);
    const ready = roll(runtime, 0).events.find(
      (e) => e.type === LudoRuntimeEventType.LEGAL_MOVES_READY,
    );
    expect(ready?.legalMoves).toEqual(
      expect.arrayContaining([
        { tokenId: 'RED-1', toProgress: 8, captures: [], safe: true },
        { tokenId: 'RED-2', toProgress: 12, captures: ['YELLOW-1'], safe: false },
      ]),
    );
  });
});

describe('classic rules (V1) are unchanged', () => {
  it('a capture passes the turn and a single move still waits for the player', () => {
    const capture = setup('LUDO_CLASSIC_V1', [10, 20], [38], [2]);
    roll(capture, 0);
    move(capture, 'RED-1', 1);
    expect(capture.getState().game.currentPlayerId).toBe('p2');

    const single = setup('LUDO_CLASSIC_V1', [20], [], [3]);
    expect(types(roll(single, 0).events)).toContain(LudoRuntimeEventType.LEGAL_MOVES_READY);
    expect(single.getState().game.turnPhase).toBe(LudoTurnPhase.WAITING_FOR_MOVE);
  });
});

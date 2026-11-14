import { FixedDiceProvider } from '../dice';
import { LudoMatchPhase, LudoTokenState, LudoTurnPhase, createInitialLudoState } from '../domain';
import { LudoMatchRuntime, LudoRuntimeEventType } from './index';

function finishStartingRoll(runtime: LudoMatchRuntime, first = 'p1', second = 'p2'): void {
  runtime.execute({
    type: 'ROLL_FOR_START',
    commandId: 'start-1',
    playerId: first,
    expectedVersion: runtime.getState().game.version,
  });
  runtime.execute({
    type: 'ROLL_FOR_START',
    commandId: 'start-2',
    playerId: second,
    expectedVersion: runtime.getState().game.version,
  });
}

describe('LudoMatchRuntime', () => {
  it('uses highest pre-roll to choose the starting player', () => {
    const runtime = new LudoMatchRuntime('m1', ['p1', 'p2'], new FixedDiceProvider([2, 5]));
    finishStartingRoll(runtime);
    const state = runtime.getState().game;
    expect(state.phase).toBe(LudoMatchPhase.PLAYING);
    expect(state.currentPlayerId).toBe('p2');
    expect(state.turnPhase).toBe(LudoTurnPhase.WAITING_FOR_ROLL);
  });

  it('rerolls only tied leaders in starting-player selection', () => {
    const runtime = new LudoMatchRuntime(
      'm1',
      ['p1', 'p2', 'p3'],
      new FixedDiceProvider([5, 5, 2, 3, 6]),
    );
    for (const playerId of ['p1', 'p2', 'p3']) {
      runtime.execute({
        type: 'ROLL_FOR_START',
        commandId: `r-${playerId}`,
        playerId,
        expectedVersion: runtime.getState().game.version,
      });
    }
    expect(runtime.getState().startingRoll.candidatePlayerIds).toEqual(['p1', 'p2']);
    for (const playerId of ['p1', 'p2']) {
      runtime.execute({
        type: 'ROLL_FOR_START',
        commandId: `rr-${playerId}`,
        playerId,
        expectedVersion: runtime.getState().game.version,
      });
    }
    expect(runtime.getState().game.currentPlayerId).toBe('p2');
  });

  it('treats a retried command as stale (persistence layer owns idempotency)', () => {
    const runtime = new LudoMatchRuntime('m1', ['p1', 'p2'], new FixedDiceProvider([4, 2]));
    const command = {
      type: 'ROLL_FOR_START' as const,
      commandId: 'same-command',
      playerId: 'p1',
      expectedVersion: 0,
    };
    runtime.execute(command);
    expect(() => runtime.execute(command)).toThrow('MATCH_VERSION_CONFLICT');
  });

  it('rejects stale expectedVersion', () => {
    const runtime = new LudoMatchRuntime('m1', ['p1', 'p2'], new FixedDiceProvider([4]));
    runtime.execute({ type: 'ROLL_FOR_START', commandId: 'a', playerId: 'p1', expectedVersion: 0 });
    expect(() =>
      runtime.execute({
        type: 'ROLL_FOR_START',
        commandId: 'b',
        playerId: 'p2',
        expectedVersion: 0,
      }),
    ).toThrow('MATCH_VERSION_CONFLICT');
  });

  it('auto-advances on a non-six when all tokens remain in base', () => {
    const runtime = new LudoMatchRuntime('m1', ['p1', 'p2'], new FixedDiceProvider([6, 1, 3]));
    finishStartingRoll(runtime);
    const result = runtime.execute({
      type: 'ROLL_DICE',
      commandId: 'roll-1',
      playerId: 'p1',
      expectedVersion: runtime.getState().game.version,
    });
    expect(result.events.some((event) => event.type === LudoRuntimeEventType.NO_LEGAL_MOVE)).toBe(
      true,
    );
    expect(runtime.getState().game.currentPlayerId).toBe('p2');
    expect(runtime.getState().game.turnPhase).toBe(LudoTurnPhase.WAITING_FOR_ROLL);
  });

  it('forfeits the third consecutive six before a third move', () => {
    const runtime = new LudoMatchRuntime(
      'm1',
      ['p1', 'p2'],
      new FixedDiceProvider([6, 1, 6, 6, 6]),
    );
    finishStartingRoll(runtime);

    runtime.execute({
      type: 'ROLL_DICE',
      commandId: 'g1',
      playerId: 'p1',
      expectedVersion: runtime.getState().game.version,
    });
    runtime.execute({
      type: 'MOVE_TOKEN',
      commandId: 'g2',
      playerId: 'p1',
      tokenId: 'RED-1',
      expectedVersion: runtime.getState().game.version,
    });
    runtime.execute({
      type: 'ROLL_DICE',
      commandId: 'g3',
      playerId: 'p1',
      expectedVersion: runtime.getState().game.version,
    });
    runtime.execute({
      type: 'MOVE_TOKEN',
      commandId: 'g4',
      playerId: 'p1',
      tokenId: 'RED-1',
      expectedVersion: runtime.getState().game.version,
    });
    const third = runtime.execute({
      type: 'ROLL_DICE',
      commandId: 'g5',
      playerId: 'p1',
      expectedVersion: runtime.getState().game.version,
    });

    expect(
      third.events.some((event) => event.type === LudoRuntimeEventType.THIRD_SIX_FORFEITED),
    ).toBe(true);
    expect(runtime.getState().game.currentPlayerId).toBe('p2');
    expect(runtime.getState().game.consecutiveSixes).toBe(0);
  });

  it('finishes a 1v1 match when one player gets all four tokens home', () => {
    const game = createInitialLudoState('m1', ['p1', 'p2']);
    game.phase = LudoMatchPhase.PLAYING;
    game.turnPhase = LudoTurnPhase.WAITING_FOR_ROLL;
    game.currentPlayerId = 'p1';
    game.players[0].tokens.forEach((token, index) => {
      token.state = index === 0 ? LudoTokenState.HOME_PATH : LudoTokenState.FINISHED;
      token.progress = index === 0 ? 56 : 57;
    });

    const runtime = LudoMatchRuntime.restore(
      {
        game,
        startingRoll: { round: 1, candidatePlayerIds: ['p1', 'p2'], rolls: {} },
        resignedPlayerIds: [],
      },
      new FixedDiceProvider([1]),
    );

    runtime.execute({ type: 'ROLL_DICE', commandId: 'roll', playerId: 'p1', expectedVersion: 0 });
    const result = runtime.execute({
      type: 'MOVE_TOKEN',
      commandId: 'move',
      playerId: 'p1',
      tokenId: 'RED-1',
      expectedVersion: 1,
    });
    expect(result.events.some((event) => event.type === LudoRuntimeEventType.MATCH_FINISHED)).toBe(
      true,
    );
    expect(runtime.getState().game.phase).toBe(LudoMatchPhase.FINISHED);
    expect(runtime.getState().game.winnerOrder).toEqual(['p1', 'p2']);
  });

  describe('a player who is out leaves only shared-track tokens for the yard', () => {
    function runtimeWithMixedTokens(tokensToWin: number) {
      const game = createInitialLudoState('m1', ['p1', 'p2', 'p3'], 'LUDO_CLASSIC_V3', { tokensToWin });
      game.phase = LudoMatchPhase.PLAYING;
      game.turnPhase = LudoTurnPhase.WAITING_FOR_ROLL;
      game.currentPlayerId = 'p1';
      const [lane, track, finished, base] = game.players[0].tokens;
      lane.state = LudoTokenState.HOME_PATH;
      lane.progress = 55;
      track.state = LudoTokenState.ACTIVE;
      track.progress = 20;
      finished.state = LudoTokenState.FINISHED;
      finished.progress = 56;
      void base;
      return LudoMatchRuntime.restore(
        {
          game,
          startingRoll: { round: 1, candidatePlayerIds: ['p1', 'p2', 'p3'], rolls: {} },
          resignedPlayerIds: [],
        },
        new FixedDiceProvider([1]),
      );
    }

    it('on reaching the goal, home-lane tokens stay in the lane', () => {
      const runtime = runtimeWithMixedTokens(2);
      runtime.execute({ type: 'ROLL_DICE', commandId: 'roll', playerId: 'p1', expectedVersion: 0 });
      const result = runtime.execute({
        type: 'MOVE_TOKEN',
        commandId: 'move',
        playerId: 'p1',
        tokenId: 'RED-1',
        expectedVersion: 1,
      });
      const finishedEvent = result.events.find((e) => e.type === LudoRuntimeEventType.PLAYER_FINISHED);
      expect(finishedEvent?.tokenIds).toEqual(['RED-2']);
      const tokens = runtime.getState().game.players[0].tokens;
      expect(tokens[0]).toMatchObject({ state: LudoTokenState.FINISHED, progress: 56 });
      expect(tokens[1]).toMatchObject({ state: LudoTokenState.BASE, progress: -1 });
      expect(tokens[2]).toMatchObject({ state: LudoTokenState.FINISHED, progress: 56 });
    });

    it('on resigning, home-lane tokens stay in the lane', () => {
      const runtime = runtimeWithMixedTokens(4);
      const result = runtime.execute({ type: 'RESIGN', commandId: 'resign', playerId: 'p1', expectedVersion: 0 });
      const resigned = result.events.find((e) => e.type === LudoRuntimeEventType.PLAYER_RESIGNED);
      expect(resigned?.tokenIds).toEqual(['RED-2']);
      const tokens = runtime.getState().game.players[0].tokens;
      expect(tokens[0]).toMatchObject({ state: LudoTokenState.HOME_PATH, progress: 55 });
      expect(tokens[1]).toMatchObject({ state: LudoTokenState.BASE, progress: -1 });
    });
  });

  it('resignation ends a 1v1 match with the opponent first', () => {
    const game = createInitialLudoState('m1', ['p1', 'p2']);
    game.phase = LudoMatchPhase.PLAYING;
    game.turnPhase = LudoTurnPhase.WAITING_FOR_ROLL;
    game.currentPlayerId = 'p1';
    const runtime = LudoMatchRuntime.restore(
      {
        game,
        startingRoll: { round: 1, candidatePlayerIds: ['p1', 'p2'], rolls: {} },
        resignedPlayerIds: [],
      },
      new FixedDiceProvider([1]),
    );
    runtime.execute({ type: 'RESIGN', commandId: 'resign', playerId: 'p1', expectedVersion: 0 });
    expect(runtime.getState().game.winnerOrder).toEqual(['p2', 'p1']);
    expect(runtime.getState().game.phase).toBe(LudoMatchPhase.FINISHED);
  });
});

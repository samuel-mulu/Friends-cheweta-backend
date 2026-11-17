import { ADMIN_OPERATIONS_ROOM, LUDO_EVENT_NAMES, RealtimePublisherService } from './realtime-publisher.service';

const LUDO = { key: 'ludo', eventNames: LUDO_EVENT_NAMES };

function createPublisher() {
  const emitted: Array<{ room: string; event: string; payload: any }> = [];
  const server = {
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => emitted.push({ room, event, payload }),
    }),
  };
  const publisher = new RealtimePublisherService();
  publisher.attach(server as any);
  return { publisher, emitted };
}

describe('RealtimePublisherService', () => {
  it('mirrors match events to the admin operations room with the same envelope', () => {
    const { publisher, emitted } = createPublisher();
    publisher.publishTurnGame(
      {
        commandId: 'c',
        duplicate: false,
        events: [{ type: 'DICE_ROLLED', matchId: 'm1', version: 3, playerId: 'A', diceValue: 4 } as any],
      },
      LUDO,
    );

    expect(emitted.map((e) => [e.room, e.event])).toEqual([
      ['match:m1', 'ludo:dice_rolled'],
      [ADMIN_OPERATIONS_ROOM, 'admin:match_event'],
    ]);
    expect(emitted[1].payload).toBe(emitted[0].payload);
  });

  it('stamps every event of one command with the same batch id and its index', () => {
    const { publisher, emitted } = createPublisher();
    publisher.publishTurnGame(
      {
        commandId: 'roll-7',
        duplicate: false,
        events: [
          { type: 'DICE_ROLLED', matchId: 'm1', version: 5 },
          { type: 'TOKEN_MOVED', matchId: 'm1', version: 6 },
          { type: 'TURN_STARTED', matchId: 'm1', version: 6 },
        ],
      },
      LUDO,
    );
    const toMatch = emitted.filter((e) => e.room === 'match:m1').map((e) => e.payload);
    expect(toMatch.map((p) => [p.batchId, p.batchIndex, p.batchSize])).toEqual([
      ['roll-7', 0, 3],
      ['roll-7', 1, 3],
      ['roll-7', 2, 3],
    ]);
    expect(new Set(toMatch.map((p) => p.eventId)).size).toBe(3);
  });

  it('uses the game prefix for an event type without a mapped name', () => {
    const { publisher, emitted } = createPublisher();
    publisher.publishTurnGame(
      { commandId: 'c', duplicate: false, events: [{ type: 'SOMETHING_NEW', matchId: 'm1', version: 1 }] },
      { key: 'dama', eventNames: {} },
    );
    expect(emitted[0].event).toBe('dama:event');
  });

  it('does not re-broadcast duplicate executions', () => {
    const { publisher, emitted } = createPublisher();
    publisher.publishTurnGame({ commandId: 'c', duplicate: true, events: [] }, LUDO);
    expect(emitted).toEqual([]);
  });

  it('fans out a challenge transition to both players, the lobby and match:ready', () => {
    const { publisher, emitted } = createPublisher();
    publisher.publishChallengeTransition({
      event: 'challenge:accepted',
      challenge: { id: 'ch', gameModeId: 'mode', challengerId: 'A', opponentId: 'B' } as any,
      restoredPlayers: [],
      leftUserIds: ['A', 'B'],
      matchReady: [
        { userId: 'A', match: { id: 'm1' } },
        { userId: 'B', match: { id: 'm1' } },
      ],
    });

    expect(emitted.map((e) => `${e.room} ${e.event}`)).toEqual([
      'user:A challenge:accepted',
      'user:B challenge:accepted',
      'lobby:mode lobby:player_left',
      'lobby:mode lobby:player_left',
      'user:A match:ready',
      'user:B match:ready',
    ]);
  });
});

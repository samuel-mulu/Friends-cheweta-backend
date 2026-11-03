import { ADMIN_OPERATIONS_ROOM, RealtimePublisherService } from './realtime-publisher.service';

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
    publisher.publishExecution({
      commandId: 'c',
      version: 3,
      duplicate: false,
      state: {} as any,
      events: [
        { type: 'DICE_ROLLED', matchId: 'm1', version: 3, playerId: 'A', diceValue: 4 } as any,
      ],
    });

    expect(emitted.map((e) => [e.room, e.event])).toEqual([
      ['match:m1', 'ludo:dice_rolled'],
      [ADMIN_OPERATIONS_ROOM, 'admin:match_event'],
    ]);
    expect(emitted[1].payload).toBe(emitted[0].payload);
  });

  it('does not re-broadcast duplicate executions', () => {
    const { publisher, emitted } = createPublisher();
    publisher.publishExecution({
      commandId: 'c',
      version: 3,
      duplicate: true,
      state: {} as any,
      events: [],
    });
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

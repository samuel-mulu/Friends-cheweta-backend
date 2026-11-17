import { UserStatus } from '../generated/prisma/enums';
import { createTestRedis } from '../test-utils/redis-test.util';
import { LobbyRooms } from './lobby-rooms';
import { LobbyService } from './lobby.service';

const GAME = { id: 'game-ludo', code: 'LUDO', name: 'Ludo', enabled: true };
const STAKES = [
  {
    id: 'ludo-10',
    gameId: GAME.id,
    stakeAmountMinor: 1000n,
    enabled: true,
    code: 'L10',
    name: 'Ludo 10',
  },
  {
    id: 'ludo-20',
    gameId: GAME.id,
    stakeAmountMinor: 2000n,
    enabled: true,
    code: 'L20',
    name: 'Ludo 20',
  },
];

async function createHarness() {
  const { redis, cleanup } = await createTestRedis();
  const prisma = {
    game: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.code === 'LUDO' ? { ...GAME, modes: STAKES } : null,
      ),
    },
    gameMode: {
      findUnique: jest.fn(async ({ where }: any) => {
        const mode = STAKES.find((stake) => stake.id === where.id);
        return mode ? { ...mode, game: GAME } : null;
      }),
      findMany: jest.fn(async () => STAKES.map(({ id, gameId }) => ({ id, gameId }))),
    },
    user: {
      findMany: jest.fn(async ({ where }: any) =>
        (where.id.in as string[]).map((id) => ({
          id,
          fullName: `Player ${id}`,
          status: UserStatus.ACTIVE,
          wallet: { availableBalance: 10_000n },
        })),
      ),
    },
    matchParticipant: { findFirst: jest.fn(async () => null) },
  };
  const rooms = new LobbyRooms(prisma as any);
  const lobby = new LobbyService(prisma as any, redis, rooms);
  return { lobby, rooms, cleanup };
}

describe('LobbyService game lobby (every stake of a game)', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('shows players at every stake, each with their stake, and counts per stake', async () => {
    await h.lobby.joinGame('A', 'LUDO', 'ludo-10');
    await h.lobby.ready('A');
    await h.lobby.joinGame('B', 'LUDO', 'ludo-20');

    const { snapshot } = await h.lobby.joinGame('C', 'LUDO');
    expect(snapshot.gameModeId).toBe('ludo-10'); // the smallest stake by default
    expect(snapshot.players.map((p) => [p.userId, p.gameModeId, p.state]).sort()).toEqual([
      ['A', 'ludo-10', 'READY'],
      ['B', 'ludo-20', 'ONLINE'],
      ['C', 'ludo-10', 'ONLINE'],
    ]);
    expect(snapshot.stakes).toEqual([
      { id: 'ludo-10', stakeAmountMinor: '1000', onlineCount: 2, readyCount: 1 },
      { id: 'ludo-20', stakeAmountMinor: '2000', onlineCount: 1, readyCount: 0 },
    ]);
  });

  it('re-opening the game keeps the stake and ready state; choosing another stake moves the player', async () => {
    await h.lobby.joinGame('A', 'LUDO', 'ludo-20');
    await h.lobby.ready('A');

    const again = await h.lobby.joinGame('A', 'LUDO');
    expect(again).toMatchObject({ gameModeId: 'ludo-20', changed: false });
    expect(again.snapshot.myState).toBe('READY');

    const moved = await h.lobby.joinGame('A', 'LUDO', 'ludo-10');
    expect(moved).toMatchObject({
      gameModeId: 'ludo-10',
      previousGameModeId: 'ludo-20',
      changed: true,
    });
    expect(moved.snapshot.myState).toBe('ONLINE');
    expect(moved.snapshot.stakes.map((s) => s.onlineCount)).toEqual([1, 0]);
  });

  it('rejects a stake of another game and refuses to move a player with a pending challenge', async () => {
    await expect(h.lobby.joinGame('A', 'LUDO', 'dama-10')).rejects.toMatchObject({
      response: { code: 'LOBBY_INVALID_MODE' },
    });
    await expect(h.lobby.joinGame('A', 'CHESS')).rejects.toMatchObject({
      response: { code: 'LOBBY_INVALID_GAME' },
    });
  });

  it('broadcasts a stake change to the stake room and the game room', async () => {
    await h.lobby.joinGame('A', 'LUDO', 'ludo-20');
    expect(h.rooms.roomsFor('ludo-20')).toEqual(['lobby:ludo-20', 'lobby-game:game-ludo']);
  });
});

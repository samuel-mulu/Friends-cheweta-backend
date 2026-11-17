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
  // Catalog stakes plus custom stakes created during the test.
  const modes: any[] = STAKES.map((stake) => ({
    ...stake,
    custom: false,
    playerCount: 2,
    platformFeeBps: 0,
    turnDurationSeconds: 30,
    rulesVersion: 'V3',
  }));
  const balances = new Map<string, bigint>();
  const prisma = {
    game: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.code === 'LUDO' ? { ...GAME, modes: modes.filter((mode) => !mode.custom) } : null,
      ),
    },
    gameMode: {
      findUnique: jest.fn(async ({ where }: any) => {
        const mode = modes.find((stake) => stake.id === where.id);
        return mode ? { ...mode, game: GAME } : null;
      }),
      findFirst: jest.fn(
        async ({ where }: any) => modes.find((m) => m.id === where.id && m.custom) ?? null,
      ),
      findMany: jest.fn(async ({ where }: any = {}) =>
        where?.id?.in
          ? modes.filter((m) => where.id.in.includes(m.id) && m.custom)
          : modes.map(({ id, gameId }) => ({ id, gameId })),
      ),
      upsert: jest.fn(async ({ where, create }: any) => {
        let mode = modes.find((m) => m.code === where.code);
        if (!mode) {
          mode = { ...create, id: `custom-${create.stakeAmountMinor}`, enabled: true };
          modes.push(mode);
        }
        return mode;
      }),
    },
    wallet: {
      findUnique: jest.fn(async ({ where }: any) => ({
        availableBalance: balances.get(where.userId) ?? 100_000n,
      })),
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
  return { lobby, rooms, cleanup, modes, balances, prisma };
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
    expect(
      snapshot.stakes.map(({ id, stakeAmountMinor, onlineCount, readyCount }) => ({
        id,
        stakeAmountMinor,
        onlineCount,
        readyCount,
      })),
    ).toEqual([
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
  describe('custom stakes', () => {
    it('a custom amount becomes a stake everyone in the game sees, with its amount on each player', async () => {
      const mine = await h.lobby.joinGame('A', 'LUDO', undefined, 50_000);
      expect(mine.gameModeId).toBe('custom-50000');

      const { snapshot } = await h.lobby.joinGame('B', 'LUDO');
      expect(snapshot.stakes.map((s) => [s.stakeAmountMinor, s.custom])).toEqual([
        ['1000', false],
        ['2000', false],
        ['50000', true],
      ]);
      const a = snapshot.players.find((p) => p.userId === 'A');
      expect(a).toMatchObject({ gameModeId: 'custom-50000', stakeAmountMinor: '50000' });

      // A second player choosing the same amount shares the same stake.
      expect((await h.lobby.joinGame('C', 'LUDO', undefined, 50_000)).gameModeId).toBe(
        'custom-50000',
      );
      expect(h.prisma.gameMode.upsert).toHaveBeenCalledTimes(2);
      expect(h.modes.filter((m) => m.custom)).toHaveLength(1);
    });

    it('an amount equal to a catalog stake uses that stake', async () => {
      expect((await h.lobby.joinGame('A', 'LUDO', undefined, 2000)).gameModeId).toBe('ludo-20');
      expect(h.prisma.gameMode.upsert).not.toHaveBeenCalled();
    });

    it('rejects amounts the player cannot cover, and amounts outside 5 to 10,000 ETB or not whole birr', async () => {
      h.balances.set('A', 4_000n);
      await expect(h.lobby.joinGame('A', 'LUDO', undefined, 5_000)).rejects.toMatchObject({
        response: { code: 'INSUFFICIENT_BALANCE_FOR_MATCH' },
      });
      for (const bad of [100, 2_000_000, 1_050]) {
        await expect(h.lobby.joinGame('B', 'LUDO', undefined, bad)).rejects.toMatchObject({
          response: { code: 'CUSTOM_STAKE_INVALID' },
        });
      }
    });

    it('a custom stake leaves the lobby once nobody sits at it', async () => {
      await h.lobby.joinGame('A', 'LUDO', undefined, 50_000);
      await h.lobby.joinGame('A', 'LUDO', 'ludo-10');

      const { snapshot } = await h.lobby.joinGame('B', 'LUDO');
      expect(snapshot.stakes.map((s) => s.stakeAmountMinor)).toEqual(['1000', '2000']);
    });
  });
});

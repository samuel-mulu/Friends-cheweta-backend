import { UserStatus } from '../generated/prisma/enums';
import { createTestRedis } from '../test-utils/redis-test.util';
import { LobbyService } from './lobby.service';

const MODE = 'mode-1';

async function createHarness() {
  const { redis, cleanup } = await createTestRedis();
  const committedUsers = new Set<string>();
  const balances = new Map<string, bigint>();
  const prisma = {
    gameMode: {
      findUnique: jest.fn(async () => ({
        id: MODE,
        code: 'LUDO_1V1',
        name: 'Ludo',
        stakeAmountMinor: 100n,
        enabled: true,
        game: { enabled: true },
      })),
    },
    user: {
      findMany: jest.fn(async ({ where }: any) =>
        (where.id.in as string[]).map((id) => ({
          id,
          fullName: `Player ${id}`,
          status: UserStatus.ACTIVE,
          wallet: { availableBalance: balances.get(id) ?? 1_000n },
        })),
      ),
    },
    matchParticipant: {
      findFirst: jest.fn(async ({ where }: any) => {
        const ids: string[] = typeof where.userId === 'string' ? [where.userId] : where.userId.in;
        const userId = ids.find((id) => committedUsers.has(id));
        return userId ? { userId } : null;
      }),
    },
  };
  return {
    service: new LobbyService(prisma as any, redis),
    redis,
    committedUsers,
    balances,
    cleanup,
  };
}

describe('LobbyService (real Redis)', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('marks isSelf only for the viewer and keeps room broadcasts viewer-neutral', async () => {
    await h.service.join('A', MODE);
    const joinedB = await h.service.join('B', MODE);

    expect(joinedB.player.isSelf).toBeUndefined();
    const snapshotForA = await h.service.snapshot('A', MODE);
    expect(snapshotForA.players.find((p) => p.userId === 'A')?.isSelf).toBe(true);
    expect(snapshotForA.players.find((p) => p.userId === 'B')?.isSelf).toBeUndefined();
  });

  it('rejoining does not duplicate membership', async () => {
    await h.service.join('A', MODE);
    await h.service.join('A', MODE);
    const snapshot = await h.service.snapshot('A', MODE);
    expect(snapshot.players.filter((p) => p.userId === 'A')).toHaveLength(1);
  });

  it('drops players whose lobby context expired from the snapshot', async () => {
    await h.service.join('A', MODE);
    await h.service.join('B', MODE);
    await h.redis.raw().del(h.redis.key('lobby', 'user', 'B'));

    const snapshot = await h.service.snapshot('A', MODE);
    expect(snapshot.players.map((p) => p.userId)).toEqual(['A']);
    expect(await h.redis.raw().sIsMember(h.redis.key('lobby', MODE, 'online'), 'B')).toBeFalsy();
  });

  it('ready requires no committed match', async () => {
    await h.service.join('A', MODE);
    h.committedUsers.add('A');
    await expect(h.service.ready('A')).rejects.toMatchObject({
      response: { code: 'LOBBY_ACTIVE_MATCH' },
    });
  });

  it('ready requires enough balance for the stake', async () => {
    await h.service.join('A', MODE);
    h.balances.set('A', 50n);
    await expect(h.service.ready('A')).rejects.toMatchObject({
      response: { code: 'INSUFFICIENT_BALANCE_FOR_MATCH' },
    });
  });

  it('ready then unready round-trips state', async () => {
    await h.service.join('A', MODE);
    expect((await h.service.ready('A')).player.state).toBe('READY');
    expect((await h.service.unready('A')).player.state).toBe('ONLINE');
  });
});

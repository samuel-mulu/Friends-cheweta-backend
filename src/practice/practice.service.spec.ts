import { normalizeEthiopianPhone } from '../common/utils/phone.util';
import { UserStatus } from '../generated/prisma/enums';
import { createTestRedis } from '../test-utils/redis-test.util';
import { PRACTICE_BOTS } from './practice.constants';
import { PracticeService } from './practice.service';

const cmd = (n: number) => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`;

async function harness() {
  const ctx = await createTestRedis();
  let committed: any = null;
  const created: any[] = [];
  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id === 'human') return { status: UserStatus.ACTIVE, isBot: false };
        if (where.phoneNumber === normalizeEthiopianPhone(PRACTICE_BOTS.HARD.phone))
          return { id: 'bot-hard', isBot: true };
        return null;
      }),
    },
    matchParticipant: { findFirst: jest.fn(async () => committed) },
    gameMode: { findFirst: jest.fn(async () => ({ id: 'mode-10', gameId: 'ludo' })) },
    match: {
      create: jest.fn(async ({ data }: any) => {
        created.push(data);
        return { id: `pm-${created.length}`, sessionCode: data.sessionCode };
      }),
    },
  };
  const timeouts = { markJoined: jest.fn(async () => undefined) };
  const service = new PracticeService(prisma as any, ctx.redis, timeouts as any);
  return { ...ctx, service, created, timeouts, setCommitted: (v: any) => (committed = v) };
}

describe('PracticeService', () => {
  let h: Awaited<ReturnType<typeof harness>>;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('creates a free READY match against the level bot and marks the bot as joined', async () => {
    const result = await h.service.start('human', 'HARD', cmd(1));
    const data = h.created[0];
    expect(result).toMatchObject({ matchId: 'pm-1', level: 'HARD', resumed: false });
    expect(data).toMatchObject({
      status: 'READY',
      stakeAmountMinor: 0n,
      source: 'PRACTICE',
      rulesVersion: 'LUDO_CLASSIC_V3',
    });
    expect(data.participants.create).toEqual([
      { userId: 'human', seat: 0 },
      { userId: 'bot-hard', seat: 1 },
    ]);
    expect(data.entries.create.every((e: any) => e.amountMinor === 0n)).toBe(true);
    expect(h.timeouts.markJoined).toHaveBeenCalledWith('pm-1', 'bot-hard');
  });

  it('a retried command returns the same match', async () => {
    const first = await h.service.start('human', 'HARD', cmd(2));
    const again = await h.service.start('human', 'HARD', cmd(2));
    expect(again.matchId).toBe(first.matchId);
    expect(h.created).toHaveLength(1);
  });

  it('resumes an unfinished practice game instead of starting another', async () => {
    h.setCommitted({ match: { id: 'old-practice', sessionCode: 'LD-OLD', source: 'PRACTICE', game: { code: 'LUDO' } } });
    expect(await h.service.start('human', 'HARD', cmd(3))).toMatchObject({
      matchId: 'old-practice',
      resumed: true,
    });
    expect(h.created).toHaveLength(0);
  });

  it('refuses while a paid match is in progress', async () => {
    h.setCommitted({ match: { id: 'paid', sessionCode: 'LD-PAID', source: 'CHALLENGE' } });
    await expect(h.service.start('human', 'HARD', cmd(4))).rejects.toMatchObject({
      response: { code: 'LOBBY_ACTIVE_MATCH' },
    });
  });
});

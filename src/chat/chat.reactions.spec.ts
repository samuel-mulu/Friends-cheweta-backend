import { MatchStatus } from '../generated/prisma/enums';
import { createTestRedis } from '../test-utils/redis-test.util';
import { ChatService } from './chat.service';

describe('ChatService.react (real Redis)', () => {
  let ctx: Awaited<ReturnType<typeof createTestRedis>>;
  let service: ChatService;

  beforeEach(async () => {
    ctx = await createTestRedis();
    const prisma = {
      match: {
        findUnique: jest.fn(async ({ where }: any) => ({
          id: where.id,
          status: MatchStatus.PLAYING,
          participants: [{ userId: 'A' }, { userId: 'B' }],
        })),
      },
    };
    service = new ChatService(prisma as any, ctx.redis, {} as any);
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('lets a participant react', async () => {
    await expect(service.react('A', 'm1', 'nice_move')).resolves.toMatchObject({
      userId: 'A',
      reactionId: 'nice_move',
    });
  });

  it('rejects people who are not in the match', async () => {
    await expect(service.react('X', 'm1', 'gg')).rejects.toMatchObject({
      response: { code: 'MATCH_CHAT_NOT_ALLOWED' },
    });
  });

  it('limits each player to one reaction per 1.5 s, independently', async () => {
    await service.react('A', 'm1', 'laugh');
    await expect(service.react('A', 'm1', 'laugh')).rejects.toMatchObject({
      response: { code: 'CHAT_RATE_LIMITED' },
    });
    await expect(service.react('B', 'm1', 'laugh')).resolves.toBeDefined();
  });
});

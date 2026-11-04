import { Prisma } from '../generated/prisma/client';
import { UserStatus } from '../generated/prisma/enums';
import { createTestRedis } from '../test-utils/redis-test.util';
import { DirectChatService } from './direct-chat.service';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';

function createHarness(redis: any) {
  const rows: any[] = [];
  const users: Record<string, { fullName: string; status: UserStatus }> = {
    [A]: { fullName: 'Abel', status: UserStatus.ACTIVE },
    [B]: { fullName: 'Bethel', status: UserStatus.ACTIVE },
    [C]: { fullName: 'Chala', status: UserStatus.BLOCKED },
  };
  let clock = 0;
  const prisma = {
    user: {
      findMany: jest.fn(async ({ where }: any) =>
        (where.id.in as string[]).filter((id) => users[id]).map((id) => ({ id, ...users[id] })),
      ),
    },
    directMessage: {
      create: jest.fn(async ({ data }: any) => {
        if (
          rows.some(
            (r) => r.senderId === data.senderId && r.clientCommandId === data.clientCommandId,
          )
        ) {
          throw new Prisma.PrismaClientKnownRequestError('dup', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        const row = {
          id: `m${rows.length + 1}`,
          readAt: null,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)),
          ...data,
        };
        rows.push(row);
        return row;
      }),
      findUnique: jest.fn(
        async ({ where }: any) =>
          rows.find(
            (r) =>
              r.senderId === where.senderId_clientCommandId.senderId &&
              r.clientCommandId === where.senderId_clientCommandId.clientCommandId,
          ) ?? null,
      ),
      findMany: jest.fn(async ({ where, take }: any) =>
        rows
          .filter((r) => r.conversationId === where.conversationId)
          .sort((x, y) => y.createdAt - x.createdAt)
          .slice(0, take),
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hits = rows.filter(
          (r) =>
            r.conversationId === where.conversationId &&
            r.recipientId === where.recipientId &&
            r.readAt === null,
        );
        hits.forEach((r) => (r.readAt = data.readAt));
        return { count: hits.length };
      }),
      groupBy: jest.fn(async ({ where }: any) => {
        const counts = new Map<string, number>();
        rows
          .filter((r) => r.recipientId === where.recipientId && r.readAt === null)
          .forEach((r) => counts.set(r.conversationId, (counts.get(r.conversationId) ?? 0) + 1));
        return [...counts].map(([conversationId, n]) => ({ conversationId, _count: { _all: n } }));
      }),
    },
    // DISTINCT ON emulation: latest row per conversation involving the user.
    $queryRaw: jest.fn(async (_strings: TemplateStringsArray, userId: string) => {
      const latest = new Map<string, any>();
      for (const r of rows.filter((x) => x.senderId === userId || x.recipientId === userId)) {
        const cur = latest.get(r.conversationId);
        if (!cur || cur.createdAt < r.createdAt) latest.set(r.conversationId, r);
      }
      return [...latest.values()];
    }),
  };
  return { service: new DirectChatService(prisma as any, redis), prisma, rows };
}

describe('DirectChatService', () => {
  let ctx: Awaited<ReturnType<typeof createTestRedis>>;
  let h: ReturnType<typeof createHarness>;
  let n = 0;
  const cmd = () => `00000000-0000-4000-9000-${String(++n).padStart(12, '0')}`;

  beforeEach(async () => {
    ctx = await createTestRedis();
    h = createHarness(ctx.redis);
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('uses one conversation id regardless of who writes first', () => {
    expect(DirectChatService.conversationId(A, B)).toBe(DirectChatService.conversationId(B, A));
  });

  it('sends, and a retried command does not create a second message', async () => {
    const commandId = cmd();
    const first = await h.service.send(A, B, commandId, '  hello  ');
    const again = await h.service.send(A, B, commandId, '  hello  ');
    expect(first.message).toMatchObject({
      text: 'hello',
      sender: { userId: A, displayName: 'Abel' },
      recipientId: B,
    });
    expect(again.duplicate).toBe(true);
    expect(again.message.id).toBe(first.message.id);
    expect(h.rows).toHaveLength(1);
  });

  it('rejects messaging yourself, blocked players and empty text', async () => {
    await expect(h.service.send(A, A, cmd(), 'hi')).rejects.toMatchObject({
      response: { code: 'CHAT_SELF' },
    });
    await expect(h.service.send(A, C, cmd(), 'hi')).rejects.toMatchObject({
      response: { code: 'PLAYER_NOT_FOUND' },
    });
    await expect(h.service.send(A, B, cmd(), '   ')).rejects.toMatchObject({
      response: { code: 'CHAT_MESSAGE_EMPTY' },
    });
  });

  it('rate-limits floods', async () => {
    for (let i = 0; i < 8; i++) await h.service.send(A, B, cmd(), `m${i}`);
    await expect(h.service.send(A, B, cmd(), 'one too many')).rejects.toMatchObject({
      response: { code: 'CHAT_RATE_LIMITED' },
    });
  });

  it('history is oldest-first for both participants', async () => {
    await h.service.send(A, B, cmd(), 'one');
    await h.service.send(B, A, cmd(), 'two');
    expect((await h.service.history(A, B)).map((m) => m.text)).toEqual(['one', 'two']);
    expect((await h.service.history(B, A)).map((m) => m.text)).toEqual(['one', 'two']);
  });

  it('inbox shows the latest message and unread count; reading clears only my unread', async () => {
    await h.service.send(A, B, cmd(), 'hi B');
    await h.service.send(A, B, cmd(), 'are you there?');

    const inboxB = await h.service.conversations(B);
    expect(inboxB.unreadTotal).toBe(2);
    expect(inboxB.conversations[0]).toMatchObject({
      peer: { userId: A, displayName: 'Abel' },
      lastMessage: { text: 'are you there?' },
      unread: 2,
    });
    expect((await h.service.conversations(A)).unreadTotal).toBe(0);

    expect(await h.service.markRead(B, A)).toBe(2);
    expect((await h.service.conversations(B)).unreadTotal).toBe(0);
  });
});

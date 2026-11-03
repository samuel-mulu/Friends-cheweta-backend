import { createTestRedis } from '../test-utils/redis-test.util';
import { PresenceService } from './presence.service';

describe('PresenceService (real Redis)', () => {
  let ctx: Awaited<ReturnType<typeof createTestRedis>>;
  let presence: PresenceService;
  beforeEach(async () => {
    ctx = await createTestRedis();
    presence = new PresenceService(ctx.redis, { get: () => 90 } as any);
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('stays online while another socket is live', async () => {
    await presence.connected('u1', 's1');
    await presence.connected('u1', 's2');
    expect(await presence.disconnected('u1', 's1')).toBe(false);
    expect(await presence.isOnline('u1')).toBe(true);
    expect(await presence.disconnected('u1', 's2')).toBe(true);
    expect(await presence.isOnline('u1')).toBe(false);
  });

  it('ignores a stale socket id left behind by a server restart', async () => {
    const key = ctx.redis.key('presence', 'user', 'u1', 'socket-seen');
    await ctx.redis.raw().zAdd(key, [{ score: Date.now() - 10 * 60_000, value: 'dead-socket' }]);

    await presence.connected('u1', 'live');
    expect(await presence.disconnected('u1', 'live')).toBe(true);
    expect(await presence.isOnline('u1')).toBe(false);
  });
});

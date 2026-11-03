import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { MatchStatus, UserStatus } from '../generated/prisma/enums';
import { ChatService } from './chat.service';

class FakeRedisRaw {
  strings = new Map<string, string>();
  lists = new Map<string, string[]>();
  expiries = new Map<string, number>();

  async rPush(key: string, value: string) {
    const list = this.lists.get(key) ?? [];
    list.push(value);
    this.lists.set(key, list);
    return list.length;
  }

  async lTrim(key: string, start: number, stop: number) {
    const list = this.lists.get(key) ?? [];
    const normalizedStart = start < 0 ? Math.max(list.length + start, 0) : start;
    const normalizedStop = stop < 0 ? list.length + stop : stop;
    this.lists.set(key, list.slice(normalizedStart, normalizedStop + 1));
    return 'OK';
  }

  async lRange(key: string) {
    return this.lists.get(key) ?? [];
  }

  async expire(key: string, seconds: number) {
    this.expiries.set(key, seconds);
    return true;
  }

  async incr(key: string) {
    const next = Number(this.strings.get(key) ?? '0') + 1;
    this.strings.set(key, String(next));
    return next;
  }

  async get(key: string) {
    return this.strings.get(key) ?? null;
  }

  async set(key: string, value: string) {
    this.strings.set(key, value);
    return 'OK';
  }
}

describe('ChatService', () => {
  function createHarness() {
    const raw = new FakeRedisRaw();
    const redis = {
      raw: () => raw,
      key: (...parts: string[]) => ['test', ...parts].join(':'),
      getJson: async <T>(key: string) => {
        const value = await raw.get(key);
        return value ? (JSON.parse(value) as T) : null;
      },
      setJson: async (key: string, value: unknown) => {
        raw.strings.set(key, JSON.stringify(value));
      },
    };
    const prisma = {
      user: { findUnique: jest.fn(async ({ where }: any) => ({ id: where.id, fullName: where.id, status: UserStatus.ACTIVE })) },
      gameMode: { findUnique: jest.fn(async () => ({ enabled: true, game: { enabled: true } })) },
      match: {
        findUnique: jest.fn(async ({ where }: any) => ({
          id: where.id,
          status: MatchStatus.PLAYING,
          participants: [{ userId: 'A' }, { userId: 'B' }],
        })),
      },
    };
    const lobby = {
      requireContext: jest.fn(async (userId: string) => {
        if (userId === 'OUT') throw new ConflictException({ code: 'LOBBY_NOT_JOINED' });
        return { gameModeId: 'mode-1', state: 'ONLINE', joinedAt: new Date().toISOString() };
      }),
    };
    return { service: new ChatService(prisma as any, redis as any, lobby as any), raw, redis, prisma };
  }

  it('rejects lobby chat from non-members', async () => {
    const { service } = createHarness();
    await expect(service.sendLobbyMessage('OUT', '00000000-0000-4000-8000-000000000001', 'hello')).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects match chat from non-participants', async () => {
    const { service } = createHarness();
    await expect(service.sendMatchMessage('C', '00000000-0000-4000-8000-000000000099', '00000000-0000-4000-8000-000000000002', 'hello')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('stores valid unicode lobby messages once with idempotency', async () => {
    const { service, raw, redis } = createHarness();
    const commandId = '00000000-0000-4000-8000-000000000003';
    const first = await service.sendLobbyMessage('A', commandId, '  ሰላም 👋  ');
    const second = await service.sendLobbyMessage('A', commandId, 'ሰላም 👋');

    expect(first.message.text).toBe('ሰላም 👋');
    expect(second.duplicate).toBe(true);
    expect(raw.lists.get(redis.key('lobby', 'mode-1', 'chat'))).toHaveLength(1);
  });

  it('stores valid match messages and applies match TTL', async () => {
    const { service, raw, redis } = createHarness();
    const result = await service.sendMatchMessage('A', '00000000-0000-4000-8000-000000000099', '00000000-0000-4000-8000-000000000004', 'Good game');

    expect(result.message.scope).toBe('MATCH');
    expect(raw.expiries.get(redis.key('match', '00000000-0000-4000-8000-000000000099', 'chat'))).toBe(86400);
  });

  it('rejects empty and too long messages', async () => {
    const { service } = createHarness();
    await expect(service.sendLobbyMessage('A', '00000000-0000-4000-8000-000000000005', '   ')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.sendLobbyMessage('A', '00000000-0000-4000-8000-000000000006', 'x'.repeat(161))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rate limits the sixth message in a window', async () => {
    const { service } = createHarness();
    for (let i = 0; i < 5; i += 1) {
      await service.sendLobbyMessage('A', `00000000-0000-4000-8000-00000000001${i}`, `msg ${i}`);
    }
    await expect(service.sendLobbyMessage('A', '00000000-0000-4000-8000-000000000020', 'six')).rejects.toBeInstanceOf(ConflictException);
  });

  it('keeps only the latest 50 history messages', async () => {
    const { service, raw, redis } = createHarness();
    for (let i = 0; i < 55; i += 1) {
      await service.sendLobbyMessage('A', `00000000-0000-4000-8000-00000000${String(i).padStart(4, '0')}`, `msg ${i}`);
      raw.strings.delete(redis.key('chat', 'rate', 'lobby', 'mode-1', 'A'));
    }
    const history = await service.getLobbyHistory('mode-1');
    expect(history).toHaveLength(50);
    expect(history[0].text).toBe('msg 5');
    expect(history[49].text).toBe('msg 54');
  });
});

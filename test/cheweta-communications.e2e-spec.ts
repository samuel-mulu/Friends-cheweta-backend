import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hash } from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { io, Socket } from 'socket.io-client';
import * as request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';

const database = process.env.CHEWETA_COMMUNICATIONS_TEST_DATABASE_URL;
const describeDb = database ? describe : describe.skip;
const password = 'communications-test-password';
const players = ['first', 'other', 'admin', 'bot'] as const;
type Account = (typeof players)[number];
interface NoticeEvent {
  data: { id?: string; kind: string; revision?: number };
}
interface NoticeInbox {
  items: { id: string; revision: number }[];
  unreadCount: number;
  forced: { id: string } | null;
  recoverableMatch: { id: string; gameCode: string } | null;
}
interface FeedbackInbox {
  items: { id: string; message: string | null; adminReply: string | null }[];
  unreadCount: number;
  seenThrough: string;
}

const readBody = <T>(response: request.Response): T => JSON.parse(response.text) as T;
const readId = (response: request.Response) => readBody<{ id: string }>(response).id;

describeDb('Cheweta player communications', () => {
  jest.setTimeout(30_000);
  const sessions: Socket[] = [];
  const tokens = new Map<Account, string>();
  const ids = new Map<Account, string>();
  let app: INestApplication<Server>;
  let prisma: PrismaService;
  let first: Socket;
  let secondDevice: Socket;
  let other: Socket;
  let admin: Socket;
  let secondAdmin: Socket;
  let bot: Socket;
  const api = () => request(app.getHttpServer());
  const auth = (name: Account) => `Bearer ${tokens.get(name)}`;
  const adminNotices = '/api/admin/broadcasts';
  const adminFeedback = '/api/admin/support/messages';
  const playerNotices = '/api/notifications/broadcasts';
  const playerFeedback = '/api/support/messages';
  const notices = (name: Account = 'first') =>
    api().get(playerNotices).set('Authorization', auth(name));
  const readNotices = async (name?: Account) =>
    readBody<NoticeInbox>(await notices(name).expect(200));
  const readFeedback = async (name: Account = 'first') =>
    readBody<FeedbackInbox>(
      await api().get(`${playerFeedback}/me`).set('Authorization', auth(name)).expect(200),
    );
  const publish = (title: string, category: string, expectedLiveId?: string) =>
    api()
      .post(adminNotices)
      .set('Authorization', auth('admin'))
      .send({ title, body: 'Test communication', category, expectedLiveId });
  const dismiss = (id: string, revision: number) =>
    api()
      .post(`${playerNotices}/${id}/dismiss`)
      .set('Authorization', auth('first'))
      .send({ revision });
  const update = (id: string, body: object) =>
    api().patch(`${adminFeedback}/${id}`).set('Authorization', auth('admin')).send(body);

  function nextEvent(socket: Socket, name: string): Promise<NoticeEvent> {
    return new Promise((resolve, reject) => {
      const handler = (message: NoticeEvent) => {
        clearTimeout(timeout);
        resolve(message);
      };
      const timeout = setTimeout(() => {
        socket.off(name, handler);
        reject(new Error(`Did not receive ${name}`));
      }, 5000);
      socket.once(name, handler);
    });
  }

  async function connect(name: Account) {
    const { port } = app.getHttpServer().address() as AddressInfo;
    const socket = io(`http://127.0.0.1:${port}/game`, {
      auth: { token: tokens.get(name) },
      transports: ['websocket'],
      autoConnect: false,
      forceNew: true,
      reconnection: false,
    });
    sessions.push(socket);
    const ready = nextEvent(socket, 'session:ready');
    socket.connect();
    await ready;
    if (name === 'admin') {
      await expect(socket.timeout(3000).emitWithAck('admin:join_operations')).resolves.toEqual({
        ok: true,
      });
    }
    return socket;
  }

  beforeAll(async () => {
    const url = new URL(database!);
    if (
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/cheweta_communications_test'
    ) {
      throw new Error('Use a disposable local cheweta_communications_test database.');
    }
    const run = Date.now().toString().slice(-7);
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: database,
      REDIS_URL: 'redis://127.0.0.1:6379',
      REDIS_KEY_PREFIX: `cheweta-communications-${run}`,
      JWT_ACCESS_SECRET: 'communications-test-access-secret',
      JWT_REFRESH_SECRET: 'communications-test-refresh-secret',
      GEEZSMS_ENABLED: 'false',
    });
    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
    await prisma.adminBroadcast.deleteMany();
    const passwordHash = await hash(password, 4);
    for (const [index, name] of players.entries()) {
      const phoneNumber = `2519${index}${run}`;
      const user = await prisma.user.create({
        data: {
          phoneNumber,
          fullName: name,
          passwordHash,
          role: name === 'admin' ? 'ADMIN' : 'PLAYER',
          isBot: name === 'bot',
        },
      });
      ids.set(name, user.id);
      if (name === 'bot') {
        const { JwtService } = await import('@nestjs/jwt');
        tokens.set(
          name,
          app.get(JwtService).sign(
            { sub: user.id, role: user.role },
            {
              secret: process.env.JWT_ACCESS_SECRET,
            },
          ),
        );
      } else {
        const session = await api()
          .post('/api/auth/login')
          .send({ phoneNumber, password })
          .expect(201);
        tokens.set(name, readBody<{ accessToken: string }>(session).accessToken);
      }
    }
    [first, secondDevice, other, admin, secondAdmin, bot] = await Promise.all([
      connect('first'),
      connect('first'),
      connect('other'),
      connect('admin'),
      connect('admin'),
      connect('bot'),
    ]);
  });

  afterAll(async () => {
    for (const socket of sessions) socket.disconnect();
    await app?.close();
  });

  it('publishes to players and admins, synchronizes dismissal by account, and restores a reminded notice', async () => {
    await expect(first.timeout(3000).emitWithAck('admin:join_operations')).resolves.toMatchObject({
      ok: false,
    });
    await notices('bot').expect(403);
    await api().get(adminNotices).set('Authorization', auth('first')).expect(403);
    const botEvents = jest.fn();
    bot.on('broadcast:changed', botEvents);
    const recipients = [first, secondDevice, other, admin, secondAdmin];
    const events = Promise.all(recipients.map((socket) => nextEvent(socket, 'broadcast:changed')));
    const noticeId = readId(await publish('New announcement', 'DISMISSIBLE').expect(201));
    for (const event of await events) {
      expect(event.data).toEqual({ id: noticeId, kind: 'PUBLISHED', revision: 1 });
    }
    const synced = nextEvent(secondDevice, 'broadcast:changed');
    const unrelated = jest.fn();
    other.on('broadcast:changed', unrelated);
    await dismiss(noticeId, 1).expect(201);
    expect((await synced).data.kind).toBe('DISMISSED');
    expect((await readNotices()).items).toEqual([]);
    expect((await readNotices('other')).items.map((item) => item.id)).toEqual([noticeId]);
    expect(unrelated).not.toHaveBeenCalled();
    other.off('broadcast:changed', unrelated);
    expect(botEvents).not.toHaveBeenCalled();
    bot.off('broadcast:changed', botEvents);

    const restored = nextEvent(first, 'broadcast:changed');
    await api()
      .post(`${adminNotices}/${noticeId}/remind`)
      .set('Authorization', auth('admin'))
      .expect(201);
    expect((await restored).data).toEqual({ id: noticeId, kind: 'REMINDED', revision: 2 });
    await dismiss(noticeId, 1).expect(409);
    const pinnedId = readId(await publish('Pinned announcement', 'PERSISTENT').expect(201));
    await dismiss(pinnedId, 1).expect(400);
    expect(await readNotices()).toMatchObject({
      unreadCount: 1,
      items: [{ id: pinnedId }, { id: noticeId, revision: 2 }],
    });
    await api()
      .delete(`${adminNotices}/${pinnedId}`)
      .set('Authorization', auth('admin'))
      .expect(200);
    expect((await readNotices()).items.map((item) => item.id)).toEqual([noticeId]);
  });

  it('serializes forced publishing and resolves only recoverable live matches', async () => {
    const competing = await Promise.all([
      publish('First competing force', 'FORCED'),
      publish('Second competing force', 'FORCED'),
    ]);
    expect(competing.map((response) => response.status).sort()).toEqual([201, 409]);
    const live = readId(competing.find((response) => response.status === 201)!);
    const replacementId = readId(await publish('Replacement force', 'FORCED', live).expect(201));
    const game = await prisma.game.upsert({
      where: { code: 'LUDO' },
      update: {},
      create: { code: 'LUDO', name: 'Ludo' },
    });
    const code = `communications-${randomUUID()}`;
    const mode = await prisma.gameMode.create({
      data: {
        gameId: game.id,
        code,
        name: 'Test',
        playerCount: 2,
        stakeAmountMinor: 0,
        platformFeeBps: 0,
        turnDurationSeconds: 30,
        rulesVersion: 'v1',
      },
    });
    const match = await prisma.match.create({
      data: {
        gameId: game.id,
        gameModeId: mode.id,
        status: 'PLAYING',
        rulesVersion: 'v1',
        source: 'PRACTICE',
        stakeAmountMinor: 0,
        platformFeeBps: 0,
        participants: { create: { userId: ids.get('first')!, seat: 0 } },
      },
    });
    expect(await readNotices()).toMatchObject({
      forced: { id: replacementId },
      recoverableMatch: null,
    });
    await prisma.match.update({ where: { id: match.id }, data: { source: null } });
    expect((await readNotices()).recoverableMatch).toEqual({
      id: match.id,
      gameCode: 'LUDO',
    });
    expect((await readNotices('other')).recoverableMatch).toBeNull();
    await dismiss(replacementId, 1).expect(400);
    await prisma.match.update({ where: { id: match.id }, data: { status: 'FINISHED' } });
    expect((await readNotices()).recoverableMatch).toBeNull();
    const turnLive = (id: string, enabled: boolean, expectedLiveId?: string) =>
      api()
        .patch(`${adminNotices}/${id}/forced-live`)
        .set('Authorization', auth('admin'))
        .send({ live: enabled, expectedLiveId });
    await turnLive(replacementId, false).expect(200);
    expect((await readNotices()).forced).toBeNull();
    await turnLive(live, true).expect(200);
    await turnLive(replacementId, true).expect(409);
    await api().delete(`${adminNotices}/${live}`).set('Authorization', auth('admin')).expect(200);
    expect((await readNotices()).forced).toBeNull();
  });

  it('keeps feedback private, retries safely, and marks replies through the selected snapshot', async () => {
    const spectator = jest.fn();
    other.on('feedback:changed', spectator);
    const submission = {
      category: 'ADVICE',
      message: 'Improve the game rules screen',
      requestId: randomUUID(),
    };
    const submit = (body = submission) =>
      api().post(playerFeedback).set('Authorization', auth('first')).send(body);
    const outcome = await Promise.all([submit().expect(201), submit().expect(201)]);
    const original = readId(outcome[0]);
    expect(readId(outcome[1])).toEqual(original);
    await submit({ ...submission, message: 'Different message' }).expect(409);
    expect((await readFeedback('other')).items).toEqual([]);
    const response = await api()
      .get(`${adminFeedback}?category=ADVICE&status=OPEN`)
      .set('Authorization', auth('admin'))
      .expect(200);
    const queue = readBody<{ items: { id: string; user: { id: string } }[] }>(response);
    expect(queue.items.find((item) => item.id === original)?.user.id).toBe(ids.get('first'));
    await api().get(`${adminFeedback}/${original}`).set('Authorization', auth('other')).expect(403);

    const replyEvents = Promise.all(
      [first, secondDevice, admin, secondAdmin].map((socket) =>
        nextEvent(socket, 'feedback:changed'),
      ),
    );
    await update(original, { adminReply: 'We have updated the help screen.' }).expect(200);
    for (const event of await replyEvents)
      expect(event.data).toEqual({ id: original, kind: 'REPLIED' });
    const snapshot = await readFeedback();
    expect(snapshot.unreadCount).toBe(1);
    await update(original, { adminReply: 'The new help screen is live.' }).expect(200);
    const mark = (seenThrough: string) =>
      api()
        .post(`${playerFeedback}/me/mark-seen`)
        .set('Authorization', auth('first'))
        .send({ seenThrough });
    expect(
      readBody<{ updated: number }>(await mark(snapshot.seenThrough).expect(201)).updated,
    ).toBe(0);
    const next = await readFeedback();
    expect(next.unreadCount).toBe(1);
    await mark(next.seenThrough).expect(201);
    expect((await readFeedback()).unreadCount).toBe(0);

    await update(original, { status: 'CLOSED' }).expect(200);
    await update(original, { status: 'OPEN' }).expect(200);
    expect((await readFeedback()).items[0]).toMatchObject({
      status: 'OPEN',
      adminReply: 'The new help screen is live.',
    });
    await api()
      .post(adminFeedback)
      .set('Authorization', auth('admin'))
      .send({ userId: ids.get('first'), adminReply: 'Private message from support.' })
      .expect(201);
    expect(await readFeedback()).toMatchObject({
      unreadCount: 1,
      items: [{ message: null, adminReply: 'Private message from support.' }, { id: original }],
    });
    expect((await readFeedback('other')).items).toEqual([]);
    expect(spectator).not.toHaveBeenCalled();
    other.off('feedback:changed', spectator);
  });
});

import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import * as request from 'supertest';
import { AuthController } from '../auth/auth.controller';
import { AuthService } from '../auth/auth.service';
import { HealthController } from '../health/health.controller';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { HttpExceptionFilter } from './filters/http-exception.filter';
import { loggerConfig } from './logging/logger.config';
import { AUTH_RATE_LIMIT, HTTP_RATE_LIMIT } from './rate-limit';

/** The HTTP baseline as wired in AppModule: request ids, rate limits, error shape. */
describe('HTTP baseline (request id and rate limits)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot(loggerConfig('test')),
        ThrottlerModule.forRoot(HTTP_RATE_LIMIT),
      ],
      controllers: [AuthController, HealthController],
      providers: [
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: AuthService, useValue: { login: jest.fn(async () => ({ ok: true })) } },
        { provide: PrismaService, useValue: { $queryRaw: jest.fn(async () => [1]) } },
        { provide: RedisService, useValue: { raw: () => ({ ping: jest.fn(async () => 'PONG') }) } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns the caller’s request id, or creates one', async () => {
    const given = await request(app.getHttpServer()).get('/health').set('x-request-id', 'abc-123');
    expect(given.headers['x-request-id']).toBe('abc-123');

    const created = await request(app.getHttpServer()).get('/health');
    expect(created.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('limits auth endpoints per client and answers 429 RATE_LIMITED with the request id', async () => {
    const login = () => request(app.getHttpServer()).post('/auth/login').send({});
    const limit = AUTH_RATE_LIMIT.default.limit;
    for (let i = 0; i < limit; i += 1) expect((await login()).status).toBe(201);

    const blocked = await login().set('x-request-id', 'flood-1');
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({
      statusCode: 429,
      code: 'RATE_LIMITED',
      requestId: 'flood-1',
    });
  });

  it('never limits the health check', async () => {
    for (let i = 0; i < 50; i += 1) await request(app.getHttpServer()).get('/health');
    expect((await request(app.getHttpServer()).get('/health')).status).toBe(200);
  });
});

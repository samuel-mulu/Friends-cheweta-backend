import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hash } from 'bcryptjs';
import request = require('supertest');
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { MatchCreationService } from '../src/match-creation/match-creation.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { SettlementService } from '../src/settlement/settlement.service';

const database = process.env.CHEWETA_WORKFLOWS_TEST_DATABASE_URL;
const describeDb = database ? describe : describe.skip;
const firstPassword = 'player-password-1';
const otp = '0427';
const fallbackWindow = {
  fallbackThreshold: 2,
  fallbackWindowMinutes: 3,
  fallbackDurationMinutes: 30,
};
const run = Date.now().toString().slice(-7);

describeDb('Cheweta payment and SMS workflows with PostgreSQL', () => {
  jest.setTimeout(60_000);
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let playerToken: string;
  let playerId: string;
  const phone = `25191${run}`;
  const adminPhone = `25192${run}`;
  const player2Phone = `25193${run}`;
  const api = () => request(app.getHttpServer());
  const admin = () => `Bearer ${adminToken}`;
  const player = () => `Bearer ${playerToken}`;
  const requests = new Map<string, { reference: string; account: string }>();
  const json = (value: unknown, status = 200) => Response.json(value, { status });

  beforeAll(async () => {
    const url = new URL(database!);
    if (
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/cheweta_workflow_test'
    ) {
      throw new Error(
        'Point CHEWETA_WORKFLOWS_TEST_DATABASE_URL to a disposable local cheweta_workflow_test database.',
      );
    }
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: database,
      REDIS_URL: 'redis://127.0.0.1:6379',
      REDIS_KEY_PREFIX: `cheweta-workflows-${run}`,
      JWT_ACCESS_SECRET: 'workflow-test-access-secret-not-production',
      JWT_REFRESH_SECRET: 'workflow-test-refresh-secret-not-production',
      GEEZSMS_ENABLED: 'true',
      GEEZSMS_TOKEN: 'workflow-token',
      GEEZSMS_BASE_URL: 'https://sms.test/api/v1',
      GEEZSMS_CALLBACK_SECRET: 'callback-secret',
      VERIFY_ET_BASE_URL: 'https://verify.test',
      VERIFY_ET_API_KEY: 'verify-secret',
      TELEBIRR_VERIFIER_URL: 'https://local-receipt.test/receipt',
      TELEBIRR_VERIFIER_TOKEN: 'receipt-secret',
      TELEBIRR_SETTLEMENT_ACCOUNT: '251911234567',
      TELEBIRR_RECEIVER_NAME: 'Cheweta',
      CBE_SETTLEMENT_ACCOUNT: '1000000012345678',
      AWASH_SETTLEMENT_ACCOUNT: '0111000012345678',
      BOA_SETTLEMENT_ACCOUNT: '0201000012345678',
      DEPOSIT_APPROVAL_PIN: '123456',
    });
    jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input as URL);
      if (url.hostname === 'sms.test')
        return json(
          url.pathname.endsWith('/balance')
            ? { error: false, data: { total_sms: 120 } }
            : { error: false, data: { code: Number(otp) } },
        );
      if (url.hostname === 'local-receipt.test') {
        const reference = url.searchParams.get('reference') ?? '';
        if (reference.startsWith('OUTAGE')) return json({}, 503);
        if (reference.startsWith('INVALID')) return json({}, 404);
        return json({
          invoiceNumber: reference,
          transactionStatus: 'Completed',
          settledAmount: '12.50',
          creditedPartyAccountNo: '*****4567',
          creditedPartyName: 'Cheweta',
        });
      }
      if (url.hostname !== 'verify.test') throw new Error('Unexpected provider request.');
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, string>;
        const reference = body.transactionNumber ?? body.referenceNumber;
        requests.set(reference, { reference, account: body.settlementAccount });
        if (reference.startsWith('WAIT'))
          return json({ requestId: reference, processingStatus: 'pending' }, 202);
        return providerResult(reference);
      }
      return providerResult(url.pathname.split('/').at(-1)!);
    });

    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.depositApprovalPin.deleteMany();
    await prisma.depositLookupFailure.deleteMany();
    await prisma.depositProviderConfig.updateMany({
      data: {
        approvalMode: 'MANUAL',
        fallbackUntil: null,
        fallbackReason: null,
      },
    });
    await prisma.user.create({
      data: {
        phoneNumber: adminPhone,
        fullName: 'Workflow Admin',
        passwordHash: await hash(firstPassword, 10),
        role: 'ADMIN',
      },
    });
    const session = await api()
      .post('/api/auth/login')
      .send({ phoneNumber: adminPhone, password: firstPassword })
      .expect(201);
    adminToken = session.body.accessToken;
  });

  afterAll(async () => {
    await app?.close();
    jest.restoreAllMocks();
  });

  function providerResult(reference: string) {
    const record = requests.get(reference);
    return json({
      requestId: reference,
      processingStatus: 'completed',
      verified: true,
      data: {
        status: 'success',
        amount: '12.50',
        currency: 'ETB',
        reference,
        settlementAccountMatch: { matched: true, submitted: record?.account },
      },
    });
  }

  function register(number: string, code: string) {
    return api().post('/api/auth/register').send({
      fullName: 'Workflow Player',
      phoneNumber: number,
      password: firstPassword,
      otp: code,
      deviceName: 'Test',
    });
  }

  function deposit(token: string, channel: string, name: string, amountMinor = '1250') {
    return api()
      .post('/api/payments/deposits')
      .set('Authorization', `Bearer ${token}`)
      .send({ channel, transactionReference: name + run, amountMinor, idempotencyKey: name + run });
  }

  function wallet(token = playerToken) {
    return api().get('/api/wallet/me').set('Authorization', `Bearer ${token}`).expect(200);
  }

  it('registers with SMS, applies OTP limits and revokes refresh sessions on password reset', async () => {
    await api().post('/api/auth/request-register-otp').send({ phoneNumber: phone }).expect(201);
    await api().post('/api/auth/request-register-otp').send({ phoneNumber: phone }).expect(429);
    await register(phone, '9999').expect(401);
    const registration = await register(phone, otp).expect(201);
    playerToken = registration.body.accessToken;
    playerId = registration.body.user.id;
    await register(phone, otp).expect(401);

    await prisma.otpChallenge.updateMany({
      where: { phoneNumber: phone },
      data: { createdAt: new Date(Date.now() - 31_000) },
    });
    const reset = await api()
      .post('/api/auth/request-password-reset-otp')
      .send({ phoneNumber: phone })
      .expect(201);
    const unknown = await api()
      .post('/api/auth/request-password-reset-otp')
      .send({ phoneNumber: `25194${run}` })
      .expect(201);
    expect(reset.body).toEqual(unknown.body);
    for (let attempt = 0; attempt < 10; attempt++) {
      const challenge = await prisma.otpChallenge.findFirst({
        where: { phoneNumber: phone, purpose: 'PASSWORD_RESET' },
      });
      if (challenge?.codeHash) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await api()
      .post('/api/auth/reset-password')
      .send({ phoneNumber: phone, otp, newPassword: 'reset-password-2' })
      .expect(201);
    await api()
      .post('/api/auth/refresh')
      .send({ refreshToken: registration.body.refreshToken })
      .expect(401);
    await api()
      .post('/api/auth/reset-password')
      .send({ phoneNumber: phone, otp, newPassword: 'unexpected-password' })
      .expect(401);
    const login = await api()
      .post('/api/auth/login')
      .send({ phoneNumber: phone, password: 'reset-password-2' })
      .expect(201);
    playerToken = login.body.accessToken;
    await api()
      .post('/api/auth/change-password')
      .set('Authorization', player())
      .send({ currentPassword: 'reset-password-2', newPassword: firstPassword })
      .expect(201);
    await api()
      .post('/api/auth/refresh')
      .send({ refreshToken: login.body.refreshToken })
      .expect(401);
    const current = await api()
      .post('/api/auth/login')
      .send({ phoneNumber: phone, password: firstPassword })
      .expect(201);
    playerToken = current.body.accessToken;

    const sms = await api()
      .get('/api/admin/payments/sms/balance')
      .set('Authorization', admin())
      .expect(200);
    expect(sms.body).toEqual({ enabled: true, balance: '120', currency: 'SMS' });
    await api().post('/api/sms/geezsms/callback').send({ status: 'delivered' }).expect(404);
    await api()
      .post('/api/sms/geezsms/callback')
      .set('x-callback-secret', 'callback-secret')
      .send({ status: 'delivered', api_log_id: 'test-message' })
      .expect(200);
  });

  it('credits a manual receipt once, locks withdrawals, handles legacy rows, and reconciles a paid Ludo game', async () => {
    const pending = await deposit(playerToken, 'CBE', 'MANUAL').expect(201);
    expect(pending.body.status).toBe('PENDING');
    await deposit(playerToken, 'CBE', 'MANUAL')
      .expect(201)
      .expect(({ body }) => expect(body.id).toBe(pending.body.id));
    const approve = (pin: string) =>
      api()
        .patch(`/api/admin/payments/deposits/${pending.body.id}/approve`)
        .set('Authorization', admin())
        .send({ approvalPin: pin });
    await approve('123457').expect(403);
    await Promise.all([approve('123456').expect(200), approve('123456').expect(200)]);
    expect((await wallet()).body.availableBalance).toBe('1250');

    const withdraw = (key: string, password = firstPassword) =>
      api()
        .post('/api/payments/withdrawals')
        .set('Authorization', player())
        .send({
          channel: 'TELEBIRR',
          destination: phone,
          amountMinor: '300',
          idempotencyKey: key + run,
          password,
        });
    await withdraw('WRONG', 'wrong-password').expect(403);
    const rejected = await withdraw('REFUND').expect(201);
    expect((await wallet()).body.lockedBalance).toBe('300');
    await api()
      .patch(`/api/admin/payments/withdrawals/${rejected.body.id}/reject`)
      .set('Authorization', admin())
      .send({ reason: 'Test refund' })
      .expect(200);
    expect((await wallet()).body.availableBalance).toBe('1250');
    const reserved = await withdraw('PAYOUT').expect(201);
    const pay = (url: string) =>
      api()
        .patch(`/api/admin/payments/withdrawals/${reserved.body.id}/approve`)
        .set('Authorization', admin())
        .send({ payoutTransactionUrl: url });
    await pay('http://bank.test/receipt').expect(400);
    const paid = await pay('https://bank.test/receipt').expect(200);
    expect(paid.body.status).toBe('PAID');
    await Promise.all([
      pay('https://bank.test/receipt').expect(200),
      pay('https://bank.test/receipt').expect(200),
    ]);
    const legacy = await prisma.withdrawal.create({
      data: {
        userId: playerId,
        amountMinor: 300n,
        destination: phone,
        channel: 'TELEBIRR',
        idempotencyKey: 'legacy' + run,
        status: 'APPROVED',
      },
    });
    await api()
      .patch(`/api/admin/payments/withdrawals/${legacy.id}/approve`)
      .set('Authorization', admin())
      .send({ payoutTransactionUrl: 'https://bank.test/legacy' })
      .expect(409);
    expect((await wallet()).body).toMatchObject({ availableBalance: '950', lockedBalance: '0' });

    await api()
      .post('/api/auth/request-register-otp')
      .send({ phoneNumber: player2Phone })
      .expect(201);
    const opponent = await register(player2Phone, otp).expect(201);
    const opponentDeposit = await deposit(opponent.body.accessToken, 'CBE', 'OPPONENT').expect(201);
    await api()
      .patch(`/api/admin/payments/deposits/${opponentDeposit.body.id}/approve`)
      .set('Authorization', admin())
      .send({ approvalPin: '123456' })
      .expect(200);

    const game = await prisma.game.upsert({
      where: { code: 'LUDO' },
      create: { code: 'LUDO', name: 'Ludo' },
      update: {},
    });
    const mode = await prisma.gameMode.create({
      data: {
        gameId: game.id,
        code: 'workflow-' + run,
        name: 'Workflow wager',
        playerCount: 2,
        stakeAmountMinor: 100n,
        platformFeeBps: 0,
        turnDurationSeconds: 30,
        rulesVersion: 'v1',
      },
    });
    const ids: [string, string] = [playerId, opponent.body.user.id];
    const match = await app
      .get(MatchCreationService)
      .createSecuredMatch({ gameModeId: mode.id, playerIds: ids, source: 'INVITE' });
    expect((await wallet()).body).toMatchObject({ availableBalance: '850', lockedBalance: '100' });
    await prisma.match.update({ where: { id: match.id }, data: { status: 'PLAYING' } });
    await app.get(SettlementService).settleMatchResult(match.id, ids);
    expect((await wallet()).body).toMatchObject({ availableBalance: '1050', lockedBalance: '0' });
  });

  it('verifies locally, distinguishes receipt mismatch from outages, resumes Verify.ET and resets fallback', async () => {
    const configure = (channel: string, approvalMode: string) =>
      api()
        .patch(`/api/admin/payments/deposit-config/${channel}`)
        .set('Authorization', admin())
        .send({ enabled: true, approvalMode, ...fallbackWindow });
    await configure('CBE', 'LOCAL').expect(400);
    await configure('TELEBIRR', 'LOCAL_WITH_FALLBACK').expect(200);
    await deposit(playerToken, 'TELEBIRR', 'AMOUNT', '1300')
      .expect(201)
      .expect(({ body }) => expect(body.lastVerificationCode).toBe('AMOUNT_MISMATCH'));
    await deposit(playerToken, 'TELEBIRR', 'INVALID')
      .expect(201)
      .expect(({ body }) => expect(body.status).toBe('REJECTED'));
    const local = await deposit(playerToken, 'TELEBIRR', 'LOCAL1').expect(201);
    expect(local.body).toMatchObject({ status: 'APPROVED', approvalMode: 'LOCAL' });

    await deposit(playerToken, 'TELEBIRR', 'OUTAGE1').expect(201);
    await deposit(playerToken, 'TELEBIRR', 'OUTAGE2').expect(201);
    const config = await api()
      .get('/api/admin/payments/deposit-config')
      .set('Authorization', admin())
      .expect(200);
    expect(
      config.body.providers.find((entry: { channel: string }) => entry.channel === 'TELEBIRR'),
    ).toMatchObject({
      approvalMode: 'LOCAL_WITH_FALLBACK',
      effectiveMode: 'AUTOMATIC',
    });

    const verifying = await deposit(playerToken, 'TELEBIRR', 'WAIT').expect(201);
    expect(verifying.body.verificationStatus).toBe('AWAITING_PROVIDER');
    const attempt = verifying.body.id;
    await prisma.deposit.update({ where: { id: attempt }, data: { nextCheckAt: new Date() } });
    await api()
      .post(`/api/payments/deposits/verification-attempts/${attempt}/check`)
      .set('Authorization', player())
      .expect(201)
      .expect(({ body }) => expect(body.status).toBe('APPROVED'));

    await prisma.depositProviderConfig.update({
      where: { channel: 'TELEBIRR' },
      data: { fallbackUntil: new Date(0) },
    });
    const expired = await api()
      .get('/api/admin/payments/deposit-config')
      .set('Authorization', admin())
      .expect(200);
    expect(
      expired.body.providers.find((entry: { channel: string }) => entry.channel === 'TELEBIRR')
        .effectiveMode,
    ).toBe('LOCAL');
    await api()
      .post('/api/admin/payments/deposit-config/telebirr/reset-fallback')
      .set('Authorization', admin())
      .expect(201);
    expect((await wallet()).body).toMatchObject({ availableBalance: '3550', lockedBalance: '0' });

    const cancellable = await deposit(playerToken, 'TELEBIRR', 'OUTAGE3').expect(201);
    await api()
      .get('/api/payments/deposits/verification-attempts/active')
      .set('Authorization', player())
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: cancellable.body.id })]),
        );
      });
    await api()
      .post(`/api/payments/deposits/verification-attempts/${cancellable.body.id}/cancel`)
      .set('Authorization', player())
      .expect(201)
      .expect(({ body }) => expect(body.verificationStatus).toBe('CANCELLED'));
    const expiring = await deposit(playerToken, 'TELEBIRR', 'OUTAGE4').expect(201);
    await prisma.deposit.update({
      where: { id: expiring.body.id },
      data: { attemptExpiresAt: new Date(0) },
    });
    await api()
      .post(`/api/payments/deposits/verification-attempts/${expiring.body.id}/check`)
      .set('Authorization', player())
      .expect(201)
      .expect(({ body }) => expect(body.verificationStatus).toBe('EXPIRED'));

    for (const channel of ['CBE', 'AWASH', 'BOA']) {
      await configure(channel, 'AUTOMATIC').expect(200);
    }
    const credited = await Promise.all(
      ['CBE', 'AWASH', 'BOA'].map((channel) =>
        deposit(playerToken, channel, `AUTO-${channel}`).expect(201),
      ),
    );
    expect(
      credited.every(({ body }) => body.approvalMode === 'AUTOMATIC' && body.status === 'APPROVED'),
    ).toBe(true);
    const ledger = await prisma.walletTransaction.findMany({
      where: { referenceId: { in: credited.map(({ body }) => body.id) } },
      orderBy: { availableBalanceBefore: 'asc' },
    });
    expect(ledger.map((entry) => entry.availableBalanceBefore)).toEqual([3550n, 4800n, 6050n]);
    expect((await wallet()).body).toMatchObject({ availableBalance: '7300', lockedBalance: '0' });
  });
});

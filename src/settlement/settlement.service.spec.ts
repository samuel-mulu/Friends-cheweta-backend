import { MatchEntryStatus, MatchStatus } from '../generated/prisma/enums';
import { WalletService } from '../wallet/wallet.service';
import { SettlementService } from './settlement.service';

/**
 * Minimal in-memory fake standing in for Prisma (match/matchSettlement/
 * matchParticipant/matchEntry/wallet/walletTransaction), used to count the
 * *actual* number of queries settleMatchResult issues per DB3 - we measure
 * this instead of estimating it.
 */
class FakeDb {
  queryCounts = new Map<string, number>();
  matches = new Map<string, any>();
  matchSettlements = new Map<string, any>();
  matchParticipants: any[] = [];
  matchEntries: any[] = [];
  wallets = new Map<string, any>();
  walletTransactionsByKey = new Map<string, any>();
  pendingFinishing: Array<{ id: string; winnerOrder: string[] }> = [];
  private seq = 0;

  count(name: string): void {
    this.queryCounts.set(name, (this.queryCounts.get(name) ?? 0) + 1);
  }

  totalQueries(): number {
    return [...this.queryCounts.values()].reduce((sum, n) => sum + n, 0);
  }

  seedStandardMatch(): void {
    this.matches.set('match-1', {
      id: 'match-1',
      status: MatchStatus.PLAYING,
      entrySecuredAt: new Date(),
      platformFeeBps: 500,
    });
    this.matchParticipants = [
      { id: 'participant-1', matchId: 'match-1', userId: 'user-1', seat: 0, resultPosition: null, finishedAt: null },
      { id: 'participant-2', matchId: 'match-1', userId: 'user-2', seat: 1, resultPosition: null, finishedAt: null },
    ];
    this.matchEntries = [
      { id: 'entry-1', matchId: 'match-1', userId: 'user-1', amountMinor: 500n, status: MatchEntryStatus.LOCKED },
      { id: 'entry-2', matchId: 'match-1', userId: 'user-2', amountMinor: 500n, status: MatchEntryStatus.LOCKED },
    ];
    this.wallets.set('user-1', { id: 'wallet-user-1', userId: 'user-1', availableBalance: 0n, lockedBalance: 500n });
    this.wallets.set('user-2', { id: 'wallet-user-2', userId: 'user-2', availableBalance: 0n, lockedBalance: 500n });
  }

  client(): any {
    const store = this;
    return {
      matchSettlement: {
        findUnique: async ({ where }: any) => {
          store.count('matchSettlement.findUnique');
          return store.matchSettlements.get(where.matchId) ?? null;
        },
        create: async ({ data }: any) => {
          store.count('matchSettlement.create');
          const row = { id: `settlement-${++store.seq}`, settledAt: new Date(), ...data };
          store.matchSettlements.set(data.matchId, row);
          return row;
        },
      },
      match: {
        findMany: async () => {
          store.count('match.findMany');
          return store.pendingFinishing;
        },
        findUnique: async ({ where }: any) => {
          store.count('match.findUnique');
          const match = store.matches.get(where.id);
          if (!match) return null;
          return {
            ...match,
            entries: store.matchEntries.filter((e) => e.matchId === match.id),
            participants: store.matchParticipants.filter((p) => p.matchId === match.id),
          };
        },
        updateMany: async ({ where, data }: any) => {
          store.count('match.updateMany');
          const match = store.matches.get(where.id);
          if (!match) return { count: 0 };
          if (where.status?.in && !where.status.in.includes(match.status)) return { count: 0 };
          Object.assign(match, data);
          return { count: 1 };
        },
        update: async ({ where, data }: any) => {
          store.count('match.update');
          const match = store.matches.get(where.id);
          Object.assign(match, data);
          return match;
        },
      },
      matchParticipant: {
        updateMany: async ({ where, data }: any) => {
          store.count('matchParticipant.updateMany');
          let matched = 0;
          for (const participant of store.matchParticipants) {
            if (participant.matchId === where.matchId && participant.userId === where.userId) {
              Object.assign(participant, data);
              matched += 1;
            }
          }
          return { count: matched };
        },
      },
      matchEntry: {
        updateMany: async ({ where, data }: any) => {
          store.count('matchEntry.updateMany');
          let matched = 0;
          for (const entry of store.matchEntries) {
            if (entry.matchId === where.matchId && entry.status === where.status) {
              Object.assign(entry, data);
              matched += 1;
            }
          }
          return { count: matched };
        },
      },
      wallet: {
        findUnique: async ({ where }: any) => {
          store.count('wallet.findUnique');
          const row = where.userId
            ? store.wallets.get(where.userId)
            : [...store.wallets.values()].find((w) => w.id === where.id);
          return row ? { ...row } : null;
        },
        updateMany: async ({ where, data }: any) => {
          store.count('wallet.updateMany');
          const wallet = [...store.wallets.values()].find((w) => w.id === where.id);
          if (!wallet) return { count: 0 };
          if (where.availableBalance?.gte !== undefined && wallet.availableBalance < where.availableBalance.gte) {
            return { count: 0 };
          }
          if (where.lockedBalance?.gte !== undefined && wallet.lockedBalance < where.lockedBalance.gte) {
            return { count: 0 };
          }
          if (data.availableBalance?.increment !== undefined) wallet.availableBalance += data.availableBalance.increment;
          if (data.lockedBalance?.increment !== undefined) wallet.lockedBalance += data.lockedBalance.increment;
          return { count: 1 };
        },
      },
      walletTransaction: {
        findUnique: async ({ where }: any) => {
          store.count('walletTransaction.findUnique');
          return store.walletTransactionsByKey.get(where.idempotencyKey) ?? null;
        },
        create: async ({ data }: any) => {
          store.count('walletTransaction.create');
          const row = { id: `wtx-${++store.seq}`, createdAt: new Date(), ...data };
          store.walletTransactionsByKey.set(data.idempotencyKey, row);
          return row;
        },
      },
      $transaction: async (fn: (tx: any) => Promise<unknown>, _options?: unknown) => fn(store.client()),
    };
  }
}

function createService() {
  const store = new FakeDb();
  const prisma = store.client();
  const wallet = new WalletService(prisma);
  const notifications = { create: jest.fn(async () => undefined) };
  const risk = { analyzeFinishedMatch: jest.fn(async () => undefined) };
  const settlement = new SettlementService(prisma, wallet, notifications as any, risk as any);
  return { settlement, store, notifications, risk };
}

describe('SettlementService.settleMatchResult (DB3)', () => {
  it('settles a standard 1v1 match and issues exactly 20 in-transaction queries', async () => {
    const { settlement, store } = createService();
    store.seedStandardMatch();

    const result = await settlement.settleMatchResult('match-1', ['user-1', 'user-2']);

    expect(result.matchId).toBe('match-1');
    expect(result.winnerUserId).toBe('user-1');
    expect(result.potAmountMinor).toBe('1000');
    expect(result.platformFeeMinor).toBe('50');
    expect(result.payoutAmountMinor).toBe('950');

    // Winner (user-1) receives the payout on top of already having spent
    // their own stake; loser (user-2) only loses their stake.
    expect(store.wallets.get('user-1')!.availableBalance).toBe(950n);
    expect(store.wallets.get('user-1')!.lockedBalance).toBe(0n);
    expect(store.wallets.get('user-2')!.availableBalance).toBe(0n);
    expect(store.wallets.get('user-2')!.lockedBalance).toBe(0n);

    expect(store.matches.get('match-1')!.status).toBe(MatchStatus.FINISHED);
    expect(store.matchEntries.every((e) => e.status === MatchEntryStatus.SETTLED)).toBe(true);

    // DB2 (wallet mutation) + DB3 (settlement) combined effect, measured -
    // not estimated. Was 23 before DB2/DB3; each of the 3 wallet mutation
    // calls (2 stake debits + 1 winner credit) dropped from 5 to 4 queries.
    const breakdown = Object.fromEntries(store.queryCounts.entries());
    expect(breakdown).toEqual({
      'matchSettlement.findUnique': 1,
      'match.findUnique': 1,
      'match.updateMany': 1,
      'walletTransaction.findUnique': 3, // 2 stake debits + 1 winner credit
      'wallet.findUnique': 3,
      'wallet.updateMany': 3,
      'walletTransaction.create': 3,
      'matchParticipant.updateMany': 2,
      'matchEntry.updateMany': 1,
      'matchSettlement.create': 1,
      'match.update': 1,
    });
    expect(store.totalQueries()).toBe(20);
  });

  it('does not block the caller on post-settlement notifications/risk work', async () => {
    const { settlement, store, notifications } = createService();
    store.seedStandardMatch();

    let notificationsSettled = false;
    notifications.create.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      notificationsSettled = true;
    });

    const startedAt = Date.now();
    const result = await settlement.settleMatchResult('match-1', ['user-1', 'user-2']);
    const elapsedMs = Date.now() - startedAt;

    expect(result.matchId).toBe('match-1');
    // The financial commit already happened; settleMatchResult must resolve
    // immediately after it, long before the (slower) notification work.
    expect(elapsedMs).toBeLessThan(100);
    expect(notificationsSettled).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(notificationsSettled).toBe(true);
  });

  it('a notification failure never turns a committed settlement into a reported failure', async () => {
    const { settlement, store, notifications, risk } = createService();
    store.seedStandardMatch();
    notifications.create.mockRejectedValue(new Error('notification channel unavailable'));

    const result = await settlement.settleMatchResult('match-1', ['user-1', 'user-2']);
    expect(result.matchId).toBe('match-1');
    expect(store.matches.get('match-1')!.status).toBe(MatchStatus.FINISHED);

    // Give the detached background task a tick to run and swallow its error.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(notifications.create).toHaveBeenCalled();
    expect(risk.analyzeFinishedMatch).not.toHaveBeenCalled(); // short-circuited by the thrown error, but settlement itself is unaffected
  });

  it('is idempotent: re-settling an already-settled match returns the same row without re-mutating wallets', async () => {
    const { settlement, store } = createService();
    store.seedStandardMatch();

    const first = await settlement.settleMatchResult('match-1', ['user-1', 'user-2']);
    store.queryCounts.clear();
    const second = await settlement.settleMatchResult('match-1', ['user-1', 'user-2']);

    expect(second.id).toBe(first.id);
    expect(store.wallets.get('user-1')!.availableBalance).toBe(950n);
    // Second call should short-circuit on the matchSettlement lookup alone.
    expect(store.queryCounts.get('matchSettlement.findUnique')).toBe(1);
    expect(store.queryCounts.get('wallet.updateMany')).toBeUndefined();
  });
});

describe('SettlementService.reconcilePending (DB5 - retry/backoff)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('backs off a repeatedly-failing match on an increasing 5s/10s/20s schedule and resets after success', async () => {
    const { settlement, store } = createService();
    store.pendingFinishing = [{ id: 'match-1', winnerOrder: ['user-1', 'user-2'] }];

    let attempt = 0;
    const settleSpy = jest.spyOn(settlement, 'settleMatchResult').mockImplementation(async () => {
      attempt += 1;
      if (attempt <= 3) throw new Error(`boom-${attempt}`);
      return { id: 'settlement-x' } as any;
    });

    let now = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);

    // t=0: first attempt fails -> schedules a 5s backoff.
    await settlement.reconcilePending();
    expect(settleSpy).toHaveBeenCalledTimes(1);

    // t=3s: still inside the 5s window - must be skipped.
    now = 3_000;
    await settlement.reconcilePending();
    expect(settleSpy).toHaveBeenCalledTimes(1);

    // t=6s: 5s elapsed -> 2nd attempt fails -> schedules a 10s backoff.
    now = 6_000;
    await settlement.reconcilePending();
    expect(settleSpy).toHaveBeenCalledTimes(2);

    // t=10s: only 4s since the 2nd attempt - still inside the 10s window.
    now = 10_000;
    await settlement.reconcilePending();
    expect(settleSpy).toHaveBeenCalledTimes(2);

    // t=17s: 11s since the 2nd attempt -> 3rd attempt fails -> schedules 20s.
    now = 17_000;
    await settlement.reconcilePending();
    expect(settleSpy).toHaveBeenCalledTimes(3);

    // t=30s: only 13s since the 3rd attempt - still inside the 20s window.
    now = 30_000;
    await settlement.reconcilePending();
    expect(settleSpy).toHaveBeenCalledTimes(3);

    // t=38s: 21s since the 3rd attempt -> 4th attempt succeeds -> backoff state cleared.
    now = 38_000;
    await settlement.reconcilePending();
    expect(settleSpy).toHaveBeenCalledTimes(4);

    // Immediately after success, the match is retried without delay (state was cleared).
    now = 38_100;
    await settlement.reconcilePending();
    expect(settleSpy).toHaveBeenCalledTimes(5);
  });

  it('caps the backoff window at 60s for a match that keeps failing', async () => {
    const { settlement, store } = createService();
    store.pendingFinishing = [{ id: 'match-1', winnerOrder: ['user-1', 'user-2'] }];

    const settleSpy = jest.spyOn(settlement, 'settleMatchResult').mockRejectedValue(new Error('always fails'));

    let now = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);

    now = 0;
    await settlement.reconcilePending(); // attempt 1 (failureCount -> 1, backoff 5s)
    now = 6_000;
    await settlement.reconcilePending(); // attempt 2 (failureCount -> 2, backoff 10s)
    now = 17_000;
    await settlement.reconcilePending(); // attempt 3 (failureCount -> 3, backoff 20s)
    now = 38_000;
    await settlement.reconcilePending(); // attempt 4 (failureCount -> 4, backoff caps at 60s)
    expect(settleSpy).toHaveBeenCalledTimes(4);

    // 59s after the 4th attempt - still inside the 60s cap - skipped.
    now = 38_000 + 59_000;
    await settlement.reconcilePending();
    expect(settleSpy).toHaveBeenCalledTimes(4);

    // 61s after the 4th attempt - cap elapsed - 5th attempt happens, still capped at 60s thereafter.
    now = 38_000 + 61_000;
    await settlement.reconcilePending();
    expect(settleSpy).toHaveBeenCalledTimes(5);
  });

  it('never throttles a direct settleMatchResult call even while reconciliation backoff is active for that match', async () => {
    const { settlement, store } = createService();
    store.seedStandardMatch();
    store.pendingFinishing = [{ id: 'match-1', winnerOrder: ['user-1', 'user-2'] }];

    const settleSpy = jest.spyOn(settlement, 'settleMatchResult').mockRejectedValueOnce(new Error('boom'));
    jest.spyOn(Date, 'now').mockImplementation(() => 0);

    await settlement.reconcilePending(); // fails once, schedules a backoff window for match-1
    expect(settleSpy).toHaveBeenCalledTimes(1);

    settleSpy.mockRestore();
    // A direct call (e.g. from the gameplay hot path) is never gated by the
    // reconciliation backoff map - only the periodic sweep consults it.
    const result = await settlement.settleMatchResult('match-1', ['user-1', 'user-2']);
    expect(result.matchId).toBe('match-1');
    expect(store.matches.get('match-1')!.status).toBe(MatchStatus.FINISHED);
  });
});

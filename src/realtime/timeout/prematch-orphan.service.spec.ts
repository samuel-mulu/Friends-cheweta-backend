import { MatchEntryStatus, MatchStatus } from '../../generated/prisma/enums';
import { PREMATCH_ORPHAN_STATUSES } from '../../common/match-status';
import { GameEntryService } from '../../game-entry/game-entry.service';
import { TurnTimeoutService } from './turn-timeout.service';

describe('prematch orphan lifecycle', () => {
  function createGameEntryHarness(initial: {
    status: MatchStatus;
    entries: Array<{ id: string; userId: string; amountMinor: bigint; status: MatchEntryStatus }>;
  }) {
    const match = {
      id: 'orphan-1',
      status: initial.status,
      entries: initial.entries.map((e) => ({ ...e })),
      cancelledAt: null as Date | null,
      cancellationReason: null as string | null,
    };
    const wallet = {
      availableBalance: 0n,
      lockedBalance: initial.entries.reduce((sum, e) => sum + (e.status === MatchEntryStatus.LOCKED ? e.amountMinor : 0n), 0n),
    };
    const ledger: string[] = [];

    const walletService = {
      releaseFundsInTransaction: jest.fn(async (_tx: unknown, input: { amountMinor: bigint; idempotencyKey: string }) => {
        if (ledger.includes(input.idempotencyKey)) return;
        wallet.lockedBalance -= input.amountMinor;
        wallet.availableBalance += input.amountMinor;
        ledger.push(input.idempotencyKey);
      }),
    };

    const prisma = {
      $transaction: async (fn: (tx: any) => Promise<unknown>) => fn(prisma),
      match: {
        findUnique: jest.fn(async () => ({ ...match, entries: match.entries.map((e) => ({ ...e })) })),
        update: jest.fn(async ({ data }: any) => {
          Object.assign(match, data);
          return match;
        }),
      },
      matchEntry: {
        update: jest.fn(async ({ where, data }: any) => {
          const entry = match.entries.find((e) => e.id === where.id)!;
          Object.assign(entry, data);
          return entry;
        }),
      },
    };

    const service = new GameEntryService(prisma as any, walletService as any);
    return { service, match, wallet, ledger, walletService };
  }

  it('cancels orphan WAITING, refunds once, and is idempotent on second call', async () => {
    const { service, match, wallet, ledger } = createGameEntryHarness({
      status: MatchStatus.WAITING,
      entries: [{ id: 'e1', userId: 'u1', amountMinor: 100n, status: MatchEntryStatus.LOCKED }],
    });

    await service.cancelAndRefund('orphan-1', 'PREMATCH_ORPHAN_TIMEOUT', {
      expectedStatuses: PREMATCH_ORPHAN_STATUSES,
    });
    expect(match.status).toBe(MatchStatus.CANCELLED);
    expect(match.entries[0].status).toBe(MatchEntryStatus.REFUNDED);
    expect(wallet.availableBalance).toBe(100n);
    expect(wallet.lockedBalance).toBe(0n);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toContain('game-entry-refund');

    await service.cancelAndRefund('orphan-1', 'PREMATCH_ORPHAN_TIMEOUT', {
      expectedStatuses: PREMATCH_ORPHAN_STATUSES,
    });
    expect(ledger).toHaveLength(1);
    expect(wallet.availableBalance).toBe(100n);
  });

  it('does not refund when match already advanced past expectedStatuses', async () => {
    const { service, match, wallet, ledger } = createGameEntryHarness({
      status: MatchStatus.READY,
      entries: [{ id: 'e1', userId: 'u1', amountMinor: 100n, status: MatchEntryStatus.LOCKED }],
    });

    const result = await service.cancelAndRefund('orphan-1', 'PREMATCH_ORPHAN_TIMEOUT', {
      expectedStatuses: PREMATCH_ORPHAN_STATUSES,
    });
    expect(result).toMatchObject({ refunded: false, skipped: true, status: MatchStatus.READY });
    expect(match.status).toBe(MatchStatus.READY);
    expect(match.entries[0].status).toBe(MatchEntryStatus.LOCKED);
    expect(wallet.lockedBalance).toBe(100n);
    expect(ledger).toHaveLength(0);
  });

  it('processPrematchOrphans cancels old candidates and skips recent WAITING', async () => {
    const cancelAndRefund = jest.fn(async (matchId: string) => ({
      matchId,
      status: MatchStatus.CANCELLED,
      refunded: true,
    }));
    const findMany = jest.fn(async ({ where }: any) => {
      // recent WAITING would fail createdAt < cutoff and never appear here
      expect(where.status.in).toEqual(PREMATCH_ORPHAN_STATUSES);
      expect(where.entrySecuredAt).toBeNull();
      expect(where.startedAt).toBeNull();
      return [{ id: 'old-orphan' }];
    });
    const prisma = {
      match: { findMany },
      matchParticipant: { findMany: jest.fn(async () => [{ userId: 'u1' }]) },
    };
    const redis = {
      raw: () => ({
        multi: () => {
          const chain: any = {
            del: () => chain,
            zRem: () => chain,
            exec: async () => undefined,
          };
          return chain;
        },
      }),
      key: (...parts: string[]) => parts.join(':'),
    };
    const publisher = { publishUser: jest.fn() };
    const runtime = { discardRuntime: jest.fn(async () => undefined) };
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'PREMATCH_ORPHAN_TIMEOUT_SECONDS') return 600;
        if (key === 'LUDO_READY_NO_SHOW_SECONDS') return 180;
        if (key === 'LUDO_DISCONNECT_GRACE_SECONDS') return 90;
        return 3;
      }),
    };
    const service = new TurnTimeoutService(
      redis as any,
      prisma as any,
      runtime as any,
      {} as any,
      publisher as any,
      { cancelAndRefund } as any,
      config as any,
    );

    const cancelled = await service.processPrematchOrphans();
    expect(cancelled).toBe(1);
    expect(runtime.discardRuntime).toHaveBeenCalledWith('old-orphan');
    expect(publisher.publishUser).toHaveBeenCalledWith('u1', 'match:cancelled', expect.objectContaining({ matchId: 'old-orphan' }), 'old-orphan');
    expect(cancelAndRefund).toHaveBeenCalledWith('old-orphan', 'PREMATCH_ORPHAN_TIMEOUT', {
      expectedStatuses: PREMATCH_ORPHAN_STATUSES,
    });

    // Recent WAITING: empty candidate set ⇒ no cancel.
    findMany.mockResolvedValueOnce([]);
    cancelAndRefund.mockClear();
    expect(await service.processPrematchOrphans()).toBe(0);
    expect(cancelAndRefund).not.toHaveBeenCalled();
  });
});

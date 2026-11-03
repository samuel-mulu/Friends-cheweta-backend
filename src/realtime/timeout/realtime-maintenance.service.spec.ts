import { RealtimeMaintenanceService } from './realtime-maintenance.service';

async function flushMicrotasks(): Promise<void> {
  await jest.advanceTimersByTimeAsync(0);
}

describe('RealtimeMaintenanceService (DB5 - independent timers)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function createService() {
    const timeouts = {
      processDueTurnTimeouts: jest.fn(async () => undefined),
      processDueDisconnects: jest.fn(async () => undefined),
      processReadyNoShows: jest.fn(async () => undefined),
      processPrematchOrphans: jest.fn(async () => 0),
    };

    let resolveReconcile: () => void = () => undefined;
    let reconcileCallCount = 0;
    const settlement = {
      reconcilePending: jest.fn(() => {
        reconcileCallCount += 1;
        return new Promise<void>((resolve) => {
          resolveReconcile = resolve;
        });
      }),
    };

    const service = new RealtimeMaintenanceService(
      timeouts as any,
      settlement as any,
      { sweep: jest.fn(async () => []) } as any,
      { publishChallengeTransition: jest.fn() } as any,
      { retryPostCommit: jest.fn(async () => undefined) } as any,
    );
    return {
      service,
      timeouts,
      settlement,
      resolveCurrentReconcile: () => resolveReconcile(),
      getReconcileCallCount: () => reconcileCallCount,
    };
  }

  it('keeps gameplay maintenance running every second while settlement reconciliation is stuck', async () => {
    const { service, timeouts, settlement } = createService();
    service.onModuleInit();

    // t=5000ms: 5th gameplay tick and 1st reconciliation tick fire together.
    // Reconciliation is deliberately left unresolved (simulating a stuck
    // settlement transaction).
    await jest.advanceTimersByTimeAsync(5000);
    expect(timeouts.processDueTurnTimeouts).toHaveBeenCalledTimes(5);
    expect(settlement.reconcilePending).toHaveBeenCalledTimes(1);

    // t=10000ms: gameplay maintenance must keep ticking every second
    // regardless - it is on its own timer/guard now, unlike before DB5.
    await jest.advanceTimersByTimeAsync(5000);
    expect(timeouts.processDueTurnTimeouts).toHaveBeenCalledTimes(10);
    expect(timeouts.processDueDisconnects).toHaveBeenCalledTimes(10);
    expect(timeouts.processReadyNoShows).toHaveBeenCalledTimes(10);

    // The still-stuck reconciliation must not have been re-entered -
    // settlementRunning guards against overlap, independent of gameplay.
    expect(settlement.reconcilePending).toHaveBeenCalledTimes(1);

    service.onApplicationShutdown();
  });

  it('releases the settlementRunning guard once reconciliation resolves, allowing the next tick', async () => {
    const { service, settlement, resolveCurrentReconcile, getReconcileCallCount } = createService();
    service.onModuleInit();

    await jest.advanceTimersByTimeAsync(5000);
    expect(getReconcileCallCount()).toBe(1);

    resolveCurrentReconcile();
    await flushMicrotasks();

    await jest.advanceTimersByTimeAsync(5000);
    expect(settlement.reconcilePending).toHaveBeenCalledTimes(2);

    service.onApplicationShutdown();
  });

  it('a failing gameplay tick does not affect the independent reconciliation timer', async () => {
    const timeouts = {
      processDueTurnTimeouts: jest.fn(async () => {
        throw new Error('redis hiccup');
      }),
      processDueDisconnects: jest.fn(async () => undefined),
      processReadyNoShows: jest.fn(async () => undefined),
      processPrematchOrphans: jest.fn(async () => 0),
    };
    const settlement = { reconcilePending: jest.fn(async () => undefined) };
    const service = new RealtimeMaintenanceService(
      timeouts as any,
      settlement as any,
      { sweep: jest.fn(async () => []) } as any,
      { publishChallengeTransition: jest.fn() } as any,
      { retryPostCommit: jest.fn(async () => undefined) } as any,
    );
    service.onModuleInit();

    await jest.advanceTimersByTimeAsync(5000);

    expect(timeouts.processDueTurnTimeouts).toHaveBeenCalledTimes(5);
    expect(settlement.reconcilePending).toHaveBeenCalledTimes(1);

    service.onApplicationShutdown();
  });
});

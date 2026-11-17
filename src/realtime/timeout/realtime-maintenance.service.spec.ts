import { RealtimeMaintenanceService } from './realtime-maintenance.service';

async function flushMicrotasks(): Promise<void> {
  await jest.advanceTimersByTimeAsync(0);
}

describe('RealtimeMaintenanceService (independent timers over the game registry)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function createService(options: { timerFails?: boolean } = {}) {
    const timer = {
      processDue: jest.fn(async () => {
        if (options.timerFails) throw new Error('redis hiccup');
      }),
    };
    const runtime = { retryPostCommit: jest.fn(async () => undefined) };
    const games = { all: () => [{ definition: { code: 'LUDO' }, runtime, timer }, { definition: { code: 'DAMA' }, runtime, timer }] };
    const disconnects = { processDue: jest.fn(async () => undefined) };
    const prematch = {
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
      games as any,
      { sweep: jest.fn(async () => []) } as any,
      settlement as any,
      { publishChallengeTransition: jest.fn() } as any,
      disconnects as any,
      prematch as any,
    );
    return {
      service,
      timer,
      runtime,
      disconnects,
      prematch,
      settlement,
      resolveCurrentReconcile: () => resolveReconcile(),
      getReconcileCallCount: () => reconcileCallCount,
    };
  }

  it('keeps gameplay maintenance running every second while settlement reconciliation is stuck', async () => {
    const { service, timer, disconnects, prematch, runtime, settlement } = createService();
    service.onModuleInit();

    // t=5000ms: 5th gameplay tick and 1st reconciliation tick fire together.
    // Reconciliation is deliberately left unresolved (a stuck settlement).
    await jest.advanceTimersByTimeAsync(5000);
    expect(timer.processDue).toHaveBeenCalledTimes(10); // two games × 5 ticks
    expect(settlement.reconcilePending).toHaveBeenCalledTimes(1);

    // t=10000ms: gameplay keeps ticking every second on its own timer/guard.
    await jest.advanceTimersByTimeAsync(5000);
    expect(timer.processDue).toHaveBeenCalledTimes(20);
    expect(disconnects.processDue).toHaveBeenCalledTimes(10);
    expect(prematch.processReadyNoShows).toHaveBeenCalledTimes(10);
    expect(prematch.processPrematchOrphans).toHaveBeenCalledTimes(10);
    expect(runtime.retryPostCommit).toHaveBeenCalledTimes(20);

    // The still-stuck reconciliation must not have been re-entered.
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
    const { service, timer, settlement } = createService({ timerFails: true });
    service.onModuleInit();

    await jest.advanceTimersByTimeAsync(5000);

    expect(timer.processDue).toHaveBeenCalledTimes(5); // first game throws each tick
    expect(settlement.reconcilePending).toHaveBeenCalledTimes(1);

    service.onApplicationShutdown();
  });
});

import { MatchSource, MatchStatus } from '../generated/prisma/enums';
import { MatchHistoryService } from './match-history.service';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('MatchHistoryService.pruneEvents', () => {
  function harness(batches: string[][]) {
    const findMany = jest.fn(async (_args: any) => (batches.shift() ?? []).map((id) => ({ id })));
    const deleteMany = jest.fn(async ({ where }: any) => ({ count: where.matchId.in.length * 5 }));
    const service = new MatchHistoryService({ match: { findMany }, matchEvent: { deleteMany } } as any);
    return { service, findMany, deleteMany };
  }

  it('deletes events only for closed matches: older than 30 days, or 1 day for practice', async () => {
    const now = Date.UTC(2026, 10, 17);
    const { service, findMany, deleteMany } = harness([['old-1', 'old-2'], ['practice-1']]);

    expect(await service.pruneEvents(now)).toBe(15);

    const closed = { in: [MatchStatus.FINISHED, MatchStatus.CANCELLED, MatchStatus.ABORTED] };
    expect(findMany.mock.calls[0][0].where).toEqual({
      updatedAt: { lt: new Date(now - 30 * DAY_MS) },
      status: closed,
      events: { some: {} },
    });
    expect(findMany.mock.calls[1][0].where).toEqual({
      source: MatchSource.PRACTICE,
      updatedAt: { lt: new Date(now - DAY_MS) },
      status: closed,
      events: { some: {} },
    });
    expect(deleteMany).toHaveBeenCalledWith({ where: { matchId: { in: ['old-1', 'old-2'] } } });
    expect(deleteMany).toHaveBeenCalledWith({ where: { matchId: { in: ['practice-1'] } } });
  });

  it('does nothing when no closed match still has events', async () => {
    const { service, deleteMany } = harness([]);
    expect(await service.pruneEvents()).toBe(0);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('works through a backlog in bounded batches', async () => {
    const full = (n: number) => Array.from({ length: 200 }, (_, i) => `m-${n}-${i}`);
    // More full batches are waiting than one run takes: 10 per rule, the rest next hour.
    const { service, findMany, deleteMany } = harness(Array.from({ length: 25 }, (_, n) => full(n)));
    await service.pruneEvents();
    expect(findMany).toHaveBeenCalledTimes(20);
    expect(deleteMany).toHaveBeenCalledTimes(20);
  });
});

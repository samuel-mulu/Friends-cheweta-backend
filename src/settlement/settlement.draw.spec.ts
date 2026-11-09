import { MatchEntryStatus, MatchStatus, WalletTransactionType } from '../generated/prisma/enums';
import { SettlementService } from './settlement.service';

function createHarness(status: MatchStatus = MatchStatus.FINISHING) {
  let settlementRow: any = null;
  const match = {
    id: 'm1',
    status,
    source: 'CHALLENGE',
    entrySecuredAt: new Date(),
    entries: [
      { userId: 'A', amountMinor: 1000n, status: MatchEntryStatus.LOCKED },
      { userId: 'B', amountMinor: 1000n, status: MatchEntryStatus.LOCKED },
    ],
    participants: [{ userId: 'A' }, { userId: 'B' }],
  };
  const tx = {
    matchSettlement: {
      findUnique: jest.fn(async () => settlementRow),
      create: jest.fn(async ({ data }: any) => (settlementRow = { id: 's1', settledAt: new Date(), ...data })),
    },
    match: {
      findUnique: jest.fn(async () => match),
      updateMany: jest.fn(async () => ({ count: 1 })),
      update: jest.fn(async () => match),
    },
    matchParticipant: { updateMany: jest.fn(async () => ({ count: 2 })) },
    matchEntry: { updateMany: jest.fn(async () => ({ count: 2 })) },
  };
  const prisma = { $transaction: jest.fn(async (run: any) => run(tx)), match: { findUnique: jest.fn(async () => null) } };
  const wallet = { releaseFundsInTransaction: jest.fn(async () => undefined) };
  const notifications = { create: jest.fn(async () => undefined) };
  const stats = { recordMatch: jest.fn(async () => 0) };
  const risk = { analyzeFinishedMatch: jest.fn(async () => undefined) };
  const service = new SettlementService(prisma as any, wallet as any, notifications as any, risk as any, stats as any);
  return { service, tx, wallet, notifications };
}

describe('SettlementService.settleDraw', () => {
  it('returns both stakes, records no winner and finishes the match as a draw', async () => {
    const h = createHarness();
    const result = await h.service.settleDraw('m1');

    expect(h.wallet.releaseFundsInTransaction).toHaveBeenCalledTimes(2);
    expect(h.wallet.releaseFundsInTransaction).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({ userId: 'A', amountMinor: 1000n, type: WalletTransactionType.GAME_ENTRY_RELEASE }),
    );
    expect(result).toMatchObject({ winnerUserId: null, potAmountMinor: '2000', payoutAmountMinor: '0', platformFeeMinor: '0' });
    expect(h.tx.match.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: MatchStatus.FINISHED, isDraw: true, winnerOrder: [] }) }),
    );
    expect(h.tx.matchEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: MatchEntryStatus.REFUNDED }) }),
    );
  });

  it('is idempotent: a second call returns the existing settlement', async () => {
    const h = createHarness();
    await h.service.settleDraw('m1');
    await h.service.settleDraw('m1');
    expect(h.wallet.releaseFundsInTransaction).toHaveBeenCalledTimes(2); // first call only
  });

  it('tells both players the match was drawn', async () => {
    const h = createHarness();
    await h.service.settleDraw('m1');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.notifications.create).toHaveBeenCalledTimes(2);
    expect(h.notifications.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Match drawn', data: expect.objectContaining({ draw: true }) }));
  });
});

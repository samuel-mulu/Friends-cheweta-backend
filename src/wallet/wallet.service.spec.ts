import { BadRequestException } from '@nestjs/common';
import { WalletTransactionType } from '../generated/prisma/enums';
import { WalletService } from './wallet.service';

type FakeWalletRow = {
  id: string;
  userId: string;
  availableBalance: bigint;
  lockedBalance: bigint;
};

type FakeLedgerRow = {
  id: string;
  walletId: string;
  type: WalletTransactionType;
  amountMinor: bigint;
  availableDelta: bigint;
  lockedDelta: bigint;
  availableBalanceBefore: bigint;
  availableBalanceAfter: bigint;
  lockedBalanceBefore: bigint;
  lockedBalanceAfter: bigint;
  referenceType: string | null;
  referenceId: string | null;
  idempotencyKey: string;
  metadata: unknown;
  createdAt: Date;
};

/**
 * Minimal in-memory fake standing in for Prisma. `wallet.updateMany` is the
 * only place that performs the guarded, atomic check-and-mutate - exactly
 * like the real `WHERE availableBalance/lockedBalance >= amount` guarded
 * update in Postgres - so it always evaluates against the *current* live
 * balance, not a value captured by an earlier read. This is what makes the
 * concurrency test below meaningful instead of trivially passing.
 */
class FakeWalletStore {
  wallets = new Map<string, FakeWalletRow>();
  ledgerByIdempotencyKey = new Map<string, FakeLedgerRow>();
  queryCounts = new Map<string, number>();
  private seq = 0;

  seedWallet(userId: string, availableBalance: bigint, lockedBalance: bigint): string {
    const id = `wallet-${userId}`;
    this.wallets.set(id, { id, userId, availableBalance, lockedBalance });
    return id;
  }

  private count(name: string): void {
    this.queryCounts.set(name, (this.queryCounts.get(name) ?? 0) + 1);
  }

  client(): any {
    const store = this;
    return {
      walletTransaction: {
        findUnique: async ({ where }: any) => {
          store.count('walletTransaction.findUnique');
          if (where.idempotencyKey) return store.ledgerByIdempotencyKey.get(where.idempotencyKey) ?? null;
          return null;
        },
        create: async ({ data }: any) => {
          store.count('walletTransaction.create');
          const row: FakeLedgerRow = { id: `wtx-${++store.seq}`, createdAt: new Date(), ...data };
          store.ledgerByIdempotencyKey.set(data.idempotencyKey, row);
          return row;
        },
      },
      wallet: {
        findUnique: async ({ where }: any) => {
          store.count('wallet.findUnique');
          // Return a snapshot copy, like a real Postgres row - never a live
          // reference the later `updateMany` could mutate out from under us.
          const row = where.userId
            ? [...store.wallets.values()].find((w) => w.userId === where.userId)
            : where.id
              ? store.wallets.get(where.id)
              : undefined;
          return row ? { ...row } : null;
        },
        updateMany: async ({ where, data }: any) => {
          store.count('wallet.updateMany');
          const wallet = store.wallets.get(where.id);
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
      $transaction: async (fn: (tx: any) => Promise<unknown>) => fn(store.client()),
    };
  }
}

function createService() {
  const store = new FakeWalletStore();
  const service = new WalletService(store.client());
  return { service, store };
}

describe('WalletService.mutateWithClient (DB2)', () => {
  it('credit: computes before/after without a post-update re-read', async () => {
    const { service, store } = createService();
    store.seedWallet('user-1', 100n, 0n);

    const result = await service.creditAvailable({
      userId: 'user-1',
      amountMinor: 50n,
      type: WalletTransactionType.DEPOSIT,
      idempotencyKey: 'credit-1',
    });

    expect(result.availableBalanceBefore).toBe('100');
    expect(result.availableBalanceAfter).toBe('150');
    expect(store.wallets.get('wallet-user-1')!.availableBalance).toBe(150n);
  });

  it('mutateWithClient issues exactly 4 queries per mutation (no post-update re-read)', async () => {
    const { service, store } = createService();
    store.seedWallet('user-1', 100n, 0n);

    // Exercise mutateWithClient directly (the shape every *InTransaction
    // caller - Settlement, GameEntry, Payments - actually uses), bypassing
    // the standalone mutate() wrapper's own extra pre-check so the count
    // reflects exactly what one wallet mutation costs inside a business
    // transaction.
    await service.creditAvailableInTransaction(store.client(), {
      userId: 'user-1',
      amountMinor: 50n,
      type: WalletTransactionType.DEPOSIT,
      idempotencyKey: 'credit-count-1',
    });

    expect(store.queryCounts.get('walletTransaction.findUnique')).toBe(1);
    expect(store.queryCounts.get('wallet.findUnique')).toBe(1);
    expect(store.queryCounts.get('wallet.updateMany')).toBe(1);
    expect(store.queryCounts.get('walletTransaction.create')).toBe(1);
    const totalQueries = [...store.queryCounts.values()].reduce((sum, n) => sum + n, 0);
    expect(totalQueries).toBe(4);
  });

  it('debit: before=100, debit=40 -> ledger before=100 after=60', async () => {
    const { service, store } = createService();
    store.seedWallet('user-1', 100n, 0n);

    const result = await service.debitAvailable({
      userId: 'user-1',
      amountMinor: 40n,
      type: WalletTransactionType.WITHDRAWAL,
      idempotencyKey: 'debit-1',
    });

    expect(result.availableBalanceBefore).toBe('100');
    expect(result.availableBalanceAfter).toBe('60');
    expect(store.wallets.get('wallet-user-1')!.availableBalance).toBe(60n);
  });

  it('lock: available=100, locked=0, lock 30 -> available=70, locked=30', async () => {
    const { service, store } = createService();
    store.seedWallet('user-1', 100n, 0n);

    const result = await service.lockFunds({
      userId: 'user-1',
      amountMinor: 30n,
      type: WalletTransactionType.GAME_ENTRY_LOCK,
      idempotencyKey: 'lock-1',
    });

    expect(result.availableBalanceBefore).toBe('100');
    expect(result.availableBalanceAfter).toBe('70');
    expect(result.lockedBalanceBefore).toBe('0');
    expect(result.lockedBalanceAfter).toBe('30');
    const wallet = store.wallets.get('wallet-user-1')!;
    expect(wallet.availableBalance).toBe(70n);
    expect(wallet.lockedBalance).toBe(30n);
  });

  it('release: is the correct inverse of lock', async () => {
    const { service, store } = createService();
    store.seedWallet('user-1', 100n, 0n);

    await service.lockFunds({
      userId: 'user-1',
      amountMinor: 30n,
      type: WalletTransactionType.GAME_ENTRY_LOCK,
      idempotencyKey: 'lock-1',
    });

    const released = await service.releaseFunds({
      userId: 'user-1',
      amountMinor: 30n,
      type: WalletTransactionType.GAME_ENTRY_RELEASE,
      idempotencyKey: 'release-1',
    });

    expect(released.availableBalanceBefore).toBe('70');
    expect(released.availableBalanceAfter).toBe('100');
    expect(released.lockedBalanceBefore).toBe('30');
    expect(released.lockedBalanceAfter).toBe('0');
    const wallet = store.wallets.get('wallet-user-1')!;
    expect(wallet.availableBalance).toBe(100n);
    expect(wallet.lockedBalance).toBe(0n);
  });

  it('debitLocked: consumes locked funds with correct ledger values', async () => {
    const { service, store } = createService();
    store.seedWallet('user-1', 70n, 30n);

    const result = await service.debitLocked({
      userId: 'user-1',
      amountMinor: 30n,
      type: WalletTransactionType.GAME_ENTRY_SPEND,
      idempotencyKey: 'spend-1',
    });

    expect(result.lockedBalanceBefore).toBe('30');
    expect(result.lockedBalanceAfter).toBe('0');
    expect(result.availableBalanceBefore).toBe('70');
    expect(result.availableBalanceAfter).toBe('70');
    const wallet = store.wallets.get('wallet-user-1')!;
    expect(wallet.lockedBalance).toBe(0n);
    expect(wallet.availableBalance).toBe(70n);
  });

  it('insufficient funds: guard still rejects and leaves the wallet unchanged', async () => {
    const { service, store } = createService();
    store.seedWallet('user-1', 100n, 0n);

    await expect(
      service.debitAvailable({
        userId: 'user-1',
        amountMinor: 150n,
        type: WalletTransactionType.WITHDRAWAL,
        idempotencyKey: 'debit-insufficient',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(store.wallets.get('wallet-user-1')!.availableBalance).toBe(100n);
    expect(store.ledgerByIdempotencyKey.has('debit-insufficient')).toBe(false);
  });

  it('idempotency: the same key applied twice produces one mutation and one ledger row', async () => {
    const { service, store } = createService();
    store.seedWallet('user-1', 100n, 0n);

    const input = {
      userId: 'user-1',
      amountMinor: 50n,
      type: WalletTransactionType.DEPOSIT,
      idempotencyKey: 'same-key',
    };

    const first = await service.creditAvailable(input);
    const second = await service.creditAvailable(input);

    expect(first.id).toBe(second.id);
    expect(store.wallets.get('wallet-user-1')!.availableBalance).toBe(150n);
    expect(store.ledgerByIdempotencyKey.size).toBe(1);
    // Second call short-circuits on the idempotency lookup alone - no second guarded update.
    expect(store.queryCounts.get('wallet.updateMany')).toBe(1);
  });

  it('concurrent debit: only the operation(s) the balance can cover succeed, wallet never goes negative', async () => {
    const { service, store } = createService();
    store.seedWallet('user-1', 100n, 0n);

    const makeDebit = (idempotencyKey: string) =>
      service
        .debitAvailable({
          userId: 'user-1',
          amountMinor: 60n,
          type: WalletTransactionType.WITHDRAWAL,
          idempotencyKey,
        })
        .then((value) => ({ ok: true as const, value }))
        .catch((error) => ({ ok: false as const, error }));

    const [a, b] = await Promise.all([makeDebit('debit-a'), makeDebit('debit-b')]);
    const outcomes = [a, b];

    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok)).toHaveLength(1);
    const failed = outcomes.find((o) => !o.ok);
    expect(failed && !failed.ok ? failed.error : null).toBeInstanceOf(BadRequestException);

    const wallet = store.wallets.get('wallet-user-1')!;
    expect(wallet.availableBalance).toBe(40n);
    expect(wallet.availableBalance >= 0n).toBe(true);
  });
});

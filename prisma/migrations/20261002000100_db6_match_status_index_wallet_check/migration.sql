-- DB6a: support `WHERE status = 'FINISHING' ORDER BY "updatedAt" ASC LIMIT 25`
-- (SettlementService.reconcilePending) without a sequential scan as the
-- Match table grows. Existing composite indexes are keyed on gameId/
-- gameModeId first, which doesn't help a status-only reconciliation sweep.
-- CreateIndex
CREATE INDEX "Match_status_updatedAt_idx" ON "Match"("status", "updatedAt");

-- DB6b: defense-in-depth financial invariant at the database level.
-- WalletService's guarded conditional updates (UPDATE ... WHERE
-- availableBalance >= :amount, checking count === 1) remain the mandatory,
-- primary protection against double-spend/negative balances - this CHECK
-- constraint does not replace that logic, it only guards against the
-- invariant ever being violated by a future bug, a raw/manual query, or an
-- out-of-band data fix.
--
-- Verification query (must return zero rows - run manually before applying
-- this migration against any environment that already has data; the DO
-- block below performs the same check automatically and aborts the
-- migration rather than silently applying a CHECK over corrupted data):
--
--   SELECT id, "userId", "availableBalance", "lockedBalance"
--   FROM "Wallet"
--   WHERE "availableBalance" < 0 OR "lockedBalance" < 0;
DO $$
DECLARE
  violation_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO violation_count
  FROM "Wallet"
  WHERE "availableBalance" < 0 OR "lockedBalance" < 0;

  IF violation_count > 0 THEN
    RAISE EXCEPTION 'DB6 migration aborted: % Wallet row(s) already violate availableBalance >= 0 AND lockedBalance >= 0. Investigate and fix the data before adding this CHECK constraint.', violation_count;
  END IF;
END $$;

-- AddCheckConstraint
ALTER TABLE "Wallet" ADD CONSTRAINT "wallet_balances_non_negative" CHECK ("availableBalance" >= 0 AND "lockedBalance" >= 0);

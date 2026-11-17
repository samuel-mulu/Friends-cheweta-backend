-- Realtime hygiene: sweep indexes, an unused index dropped, and three text
-- columns turned into enums. No rows are added, removed or rewritten with
-- different values; users, wallets, ledger and matches are untouched.

-- 1. Indexes for the maintenance sweeps.
--    Ready no-shows:    WHERE status = 'READY' AND "entrySecuredAt" < :cutoff ORDER BY "entrySecuredAt"
--    Abandoned matches: WHERE status IN ('CREATED','WAITING') AND "createdAt" < :cutoff ORDER BY "createdAt"
CREATE INDEX "Match_status_entrySecuredAt_idx" ON "Match"("status", "entrySecuredAt");
CREATE INDEX "Match_status_createdAt_idx" ON "Match"("status", "createdAt");

-- 2. No query filters or orders MatchEvent by createdAt within a match
--    (replay orders by sequence, which has its own unique index).
DROP INDEX "MatchEvent_matchId_createdAt_idx";

-- 3. Enums. Each conversion first refuses to run if the column holds a value
--    the enum does not have, so nothing can be lost or silently changed.
DO $$
DECLARE
  bad TEXT;
BEGIN
  SELECT string_agg(DISTINCT "source", ', ') INTO bad
    FROM "Match"
   WHERE "source" IS NOT NULL AND "source" NOT IN ('CHALLENGE', 'REMATCH', 'INVITE', 'PRACTICE');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Match.source has values outside MatchSource: %', bad;
  END IF;

  SELECT string_agg(DISTINCT "severity", ', ') INTO bad
    FROM "RiskFlag"
   WHERE "severity" NOT IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'RiskFlag.severity has values outside RiskSeverity: %', bad;
  END IF;

  SELECT string_agg(DISTINCT "status", ', ') INTO bad
    FROM "RiskFlag"
   WHERE "status" NOT IN ('OPEN', 'REVIEWED', 'DISMISSED');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'RiskFlag.status has values outside RiskFlagStatus: %', bad;
  END IF;
END $$;

CREATE TYPE "MatchSource" AS ENUM ('CHALLENGE', 'REMATCH', 'INVITE', 'PRACTICE');
-- Least to most severe, so ORDER BY severity DESC lists the worst first
-- (as text, MEDIUM sorted above HIGH).
CREATE TYPE "RiskSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
CREATE TYPE "RiskFlagStatus" AS ENUM ('OPEN', 'REVIEWED', 'DISMISSED');

ALTER TABLE "Match"
  ALTER COLUMN "source" TYPE "MatchSource" USING "source"::"MatchSource";

-- The composite index includes both columns; it is rebuilt by the type change.
ALTER TABLE "RiskFlag"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "severity" TYPE "RiskSeverity" USING "severity"::"RiskSeverity",
  ALTER COLUMN "status" TYPE "RiskFlagStatus" USING "status"::"RiskFlagStatus",
  ALTER COLUMN "status" SET DEFAULT 'OPEN';

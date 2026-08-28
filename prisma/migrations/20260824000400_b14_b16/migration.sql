ALTER TYPE "WalletTransactionType" ADD VALUE IF NOT EXISTS 'GAME_ENTRY_SPEND';

CREATE TYPE "MatchEntryStatus" AS ENUM ('LOCKED', 'REFUNDED', 'SETTLED');

ALTER TABLE "Match"
  ADD COLUMN "entrySecuredAt" TIMESTAMP(3),
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancellationReason" TEXT,
  ADD COLUMN "winnerOrder" JSONB,
  ADD COLUMN "resultVersion" INTEGER;

CREATE TABLE "MatchEntry" (
  "id" TEXT NOT NULL,
  "matchId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "status" "MatchEntryStatus" NOT NULL DEFAULT 'LOCKED',
  "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "refundedAt" TIMESTAMP(3),
  "settledAt" TIMESTAMP(3),
  CONSTRAINT "MatchEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MatchSettlement" (
  "id" TEXT NOT NULL,
  "matchId" TEXT NOT NULL,
  "winnerUserId" TEXT NOT NULL,
  "potAmountMinor" BIGINT NOT NULL,
  "platformFeeMinor" BIGINT NOT NULL,
  "payoutAmountMinor" BIGINT NOT NULL,
  "winnerOrder" JSONB NOT NULL,
  "settledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MatchSettlement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MatchEntry_matchId_userId_key" ON "MatchEntry"("matchId", "userId");
CREATE INDEX "MatchEntry_userId_status_idx" ON "MatchEntry"("userId", "status");
CREATE UNIQUE INDEX "MatchSettlement_matchId_key" ON "MatchSettlement"("matchId");

ALTER TABLE "MatchEntry"
  ADD CONSTRAINT "MatchEntry_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "MatchEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MatchSettlement"
  ADD CONSTRAINT "MatchSettlement_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

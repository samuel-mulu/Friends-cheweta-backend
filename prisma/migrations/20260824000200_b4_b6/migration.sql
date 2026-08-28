-- B4: Deposits & Withdrawals
ALTER TYPE "WalletTransactionType" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_LOCK';
ALTER TYPE "WalletTransactionType" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_RELEASE';
ALTER TYPE "WalletTransactionType" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_PAYOUT';

CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "PaymentChannel" AS ENUM ('CBE', 'TELEBIRR', 'MANUAL', 'OTHER');
CREATE TYPE "MatchStatus" AS ENUM ('CREATED', 'WAITING', 'READY', 'PLAYING', 'FINISHING', 'FINISHED', 'CANCELLED', 'ABORTED');

CREATE TABLE "Deposit" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "channel" "PaymentChannel" NOT NULL,
  "transactionReference" TEXT NOT NULL,
  "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
  "idempotencyKey" TEXT NOT NULL,
  "note" TEXT,
  "reviewedByUserId" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "rejectionReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Deposit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Withdrawal" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "channel" "PaymentChannel" NOT NULL,
  "destination" TEXT NOT NULL,
  "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
  "idempotencyKey" TEXT NOT NULL,
  "note" TEXT,
  "reviewedByUserId" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "rejectionReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Withdrawal_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_amountMinor_positive" CHECK ("amountMinor" > 0);
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_amountMinor_positive" CHECK ("amountMinor" > 0);

CREATE UNIQUE INDEX "Deposit_transactionReference_key" ON "Deposit"("transactionReference");
CREATE UNIQUE INDEX "Deposit_idempotencyKey_key" ON "Deposit"("idempotencyKey");
CREATE INDEX "Deposit_userId_createdAt_idx" ON "Deposit"("userId", "createdAt");
CREATE INDEX "Deposit_status_createdAt_idx" ON "Deposit"("status", "createdAt");
CREATE UNIQUE INDEX "Withdrawal_idempotencyKey_key" ON "Withdrawal"("idempotencyKey");
CREATE INDEX "Withdrawal_userId_createdAt_idx" ON "Withdrawal"("userId", "createdAt");
CREATE INDEX "Withdrawal_status_createdAt_idx" ON "Withdrawal"("status", "createdAt");

ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- B5: Gaming Platform Core
CREATE TABLE "Game" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Game_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GameMode" (
  "id" TEXT NOT NULL,
  "gameId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "playerCount" INTEGER NOT NULL,
  "stakeAmountMinor" BIGINT NOT NULL,
  "platformFeeBps" INTEGER NOT NULL,
  "turnDurationSeconds" INTEGER NOT NULL,
  "rulesVersion" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GameMode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Match" (
  "id" TEXT NOT NULL,
  "gameId" TEXT NOT NULL,
  "gameModeId" TEXT NOT NULL,
  "status" "MatchStatus" NOT NULL DEFAULT 'CREATED',
  "rulesVersion" TEXT NOT NULL,
  "stakeAmountMinor" BIGINT NOT NULL,
  "platformFeeBps" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MatchParticipant" (
  "id" TEXT NOT NULL,
  "matchId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "seat" INTEGER NOT NULL,
  "resultPosition" INTEGER,
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "MatchParticipant_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "GameMode" ADD CONSTRAINT "GameMode_playerCount_range" CHECK ("playerCount" BETWEEN 2 AND 4);
ALTER TABLE "GameMode" ADD CONSTRAINT "GameMode_stake_nonnegative" CHECK ("stakeAmountMinor" >= 0);
ALTER TABLE "GameMode" ADD CONSTRAINT "GameMode_fee_bps_range" CHECK ("platformFeeBps" BETWEEN 0 AND 10000);
ALTER TABLE "GameMode" ADD CONSTRAINT "GameMode_turn_duration_positive" CHECK ("turnDurationSeconds" > 0);
ALTER TABLE "Match" ADD CONSTRAINT "Match_stake_nonnegative" CHECK ("stakeAmountMinor" >= 0);
ALTER TABLE "Match" ADD CONSTRAINT "Match_fee_bps_range" CHECK ("platformFeeBps" BETWEEN 0 AND 10000);

CREATE UNIQUE INDEX "Game_code_key" ON "Game"("code");
CREATE UNIQUE INDEX "GameMode_code_key" ON "GameMode"("code");
CREATE INDEX "GameMode_gameId_enabled_idx" ON "GameMode"("gameId", "enabled");
CREATE INDEX "Match_gameId_status_createdAt_idx" ON "Match"("gameId", "status", "createdAt");
CREATE INDEX "Match_gameModeId_status_createdAt_idx" ON "Match"("gameModeId", "status", "createdAt");
CREATE UNIQUE INDEX "MatchParticipant_matchId_userId_key" ON "MatchParticipant"("matchId", "userId");
CREATE UNIQUE INDEX "MatchParticipant_matchId_seat_key" ON "MatchParticipant"("matchId", "seat");
CREATE INDEX "MatchParticipant_userId_joinedAt_idx" ON "MatchParticipant"("userId", "joinedAt");

ALTER TABLE "GameMode" ADD CONSTRAINT "GameMode_gameId_fkey"
FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Match" ADD CONSTRAINT "Match_gameId_fkey"
FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Match" ADD CONSTRAINT "Match_gameModeId_fkey"
FOREIGN KEY ("gameModeId") REFERENCES "GameMode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MatchParticipant" ADD CONSTRAINT "MatchParticipant_matchId_fkey"
FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MatchParticipant" ADD CONSTRAINT "MatchParticipant_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

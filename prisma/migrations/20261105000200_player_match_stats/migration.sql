-- Player stats per finished match. New table only; existing data untouched.
CREATE TABLE "PlayerMatchStat" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "won" BOOLEAN NOT NULL,
    "rolls" INTEGER NOT NULL,
    "sixes" INTEGER NOT NULL,
    "captures" INTEGER NOT NULL,
    "tokensLost" INTEGER NOT NULL,
    "tokensHome" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlayerMatchStat_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlayerMatchStat_matchId_userId_key" ON "PlayerMatchStat"("matchId", "userId");
CREATE INDEX "PlayerMatchStat_userId_createdAt_idx" ON "PlayerMatchStat"("userId", "createdAt");
CREATE INDEX "PlayerMatchStat_createdAt_idx" ON "PlayerMatchStat"("createdAt");

ALTER TABLE "PlayerMatchStat" ADD CONSTRAINT "PlayerMatchStat_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PlayerMatchStat" ADD CONSTRAINT "PlayerMatchStat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

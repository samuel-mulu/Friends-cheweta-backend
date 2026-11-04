-- Rematch link: nullable, additive, no backfill. Safe on existing data.
ALTER TABLE "Match" ADD COLUMN "rematchOfMatchId" TEXT;
CREATE INDEX "Match_rematchOfMatchId_idx" ON "Match"("rematchOfMatchId");

ALTER TABLE "Match" ADD COLUMN "matchmakingKey" TEXT;
CREATE UNIQUE INDEX "Match_matchmakingKey_key" ON "Match"("matchmakingKey");

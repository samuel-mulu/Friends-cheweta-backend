ALTER TABLE "Match" ADD COLUMN "sessionCode" TEXT;
ALTER TABLE "Match" ADD COLUMN "challengeId" TEXT;
ALTER TABLE "Match" ADD COLUMN "source" TEXT;

CREATE UNIQUE INDEX "Match_sessionCode_key" ON "Match"("sessionCode");
CREATE UNIQUE INDEX "Match_challengeId_key" ON "Match"("challengeId");

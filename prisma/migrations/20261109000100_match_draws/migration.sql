-- Dama draws: a finished match may have no winner (stakes are returned).
ALTER TABLE "Match" ADD COLUMN "isDraw" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "MatchSettlement" ALTER COLUMN "winnerUserId" DROP NOT NULL;

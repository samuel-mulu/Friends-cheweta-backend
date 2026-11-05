-- "First to N home": tokens a player must bring home to finish (1-4).
-- Additive with a default, so existing matches keep the classic rule (4).
ALTER TABLE "Match" ADD COLUMN "tokensToWin" INTEGER NOT NULL DEFAULT 4;

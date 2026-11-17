-- Custom stakes: a stake amount a player chose in a game's lobby (outside the
-- catalog). Additive; existing stakes stay catalog stakes.
ALTER TABLE "GameMode" ADD COLUMN "custom" BOOLEAN NOT NULL DEFAULT false;

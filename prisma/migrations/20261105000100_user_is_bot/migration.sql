-- Practice bots. Additive column with a default; existing users are unaffected.
ALTER TABLE "User" ADD COLUMN "isBot" BOOLEAN NOT NULL DEFAULT false;

-- CreateEnum
CREATE TYPE "BroadcastKind" AS ENUM ('DISMISSIBLE', 'PERSISTENT', 'FORCED');

-- CreateEnum
CREATE TYPE "FeedbackCategory" AS ENUM ('FEEDBACK', 'COMPLAINT', 'ADVICE', 'OTHER');

-- CreateEnum
CREATE TYPE "FeedbackStatus" AS ENUM ('OPEN', 'REPLIED', 'CLOSED');

-- CreateTable
CREATE TABLE "AdminBroadcast" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" "BroadcastKind" NOT NULL DEFAULT 'DISMISSIBLE',
    "forcedLive" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "AdminBroadcast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BroadcastDismissal" (
    "broadcastId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BroadcastDismissal_pkey" PRIMARY KEY ("broadcastId","userId")
);

-- CreateTable
CREATE TABLE "PlayerFeedback" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" "FeedbackCategory" NOT NULL,
    "message" TEXT,
    "requestId" TEXT,
    "status" "FeedbackStatus" NOT NULL DEFAULT 'OPEN',
    "adminReply" TEXT,
    "repliedById" TEXT,
    "repliedAt" TIMESTAMP(3),
    "replyCursor" BIGINT,
    "playerSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlayerFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminBroadcast_deletedAt_category_createdAt_id_idx" ON "AdminBroadcast"("deletedAt", "category", "createdAt", "id");

-- CreateIndex
CREATE INDEX "BroadcastDismissal_userId_idx" ON "BroadcastDismissal"("userId");

-- CreateIndex
CREATE INDEX "PlayerFeedback_status_createdAt_id_idx" ON "PlayerFeedback"("status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "PlayerFeedback_userId_createdAt_id_idx" ON "PlayerFeedback"("userId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "PlayerFeedback_userId_replyCursor_idx" ON "PlayerFeedback"("userId", "replyCursor");

-- CreateIndex
CREATE UNIQUE INDEX "PlayerFeedback_userId_requestId_key" ON "PlayerFeedback"("userId", "requestId");

-- AddForeignKey
ALTER TABLE "AdminBroadcast" ADD CONSTRAINT "AdminBroadcast_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BroadcastDismissal" ADD CONSTRAINT "BroadcastDismissal_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "AdminBroadcast"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BroadcastDismissal" ADD CONSTRAINT "BroadcastDismissal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerFeedback" ADD CONSTRAINT "PlayerFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerFeedback" ADD CONSTRAINT "PlayerFeedback_repliedById_fkey" FOREIGN KEY ("repliedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- At most one forced notice may block players at any time.
CREATE UNIQUE INDEX "AdminBroadcast_one_live_forced" ON "AdminBroadcast" ("forcedLive")
WHERE "category" = 'FORCED' AND "forcedLive" AND "deletedAt" IS NULL;

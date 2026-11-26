-- CreateEnum
CREATE TYPE "DepositApprovalMode" AS ENUM ('MANUAL', 'AUTOMATIC', 'LOCAL', 'LOCAL_WITH_FALLBACK');

-- CreateEnum
CREATE TYPE "DepositVerificationStatus" AS ENUM ('READY', 'VERIFYING', 'AWAITING_PROVIDER', 'UNAVAILABLE', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('REGISTER', 'PASSWORD_RESET');

-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'PAID';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PaymentChannel" ADD VALUE 'AWASH';
ALTER TYPE "PaymentChannel" ADD VALUE 'BOA';

-- DropIndex
DROP INDEX "Deposit_transactionReference_key";

-- AlterTable
ALTER TABLE "Deposit" ADD COLUMN     "approvalMode" "DepositApprovalMode",
ADD COLUMN     "attemptExpiresAt" TIMESTAMP(3),
ADD COLUMN     "lastVerificationCode" TEXT,
ADD COLUMN     "nextCheckAt" TIMESTAMP(3),
ADD COLUMN     "providerRequestId" TEXT,
ADD COLUMN     "referenceKey" TEXT,
ADD COLUMN     "verificationStatus" "DepositVerificationStatus";

-- AlterTable
ALTER TABLE "Withdrawal" ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "payoutTransactionUrl" TEXT;

-- CreateTable
CREATE TABLE "DepositProviderConfig" (
    "channel" "PaymentChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "approvalMode" "DepositApprovalMode" NOT NULL DEFAULT 'MANUAL',
    "fallbackThreshold" INTEGER NOT NULL DEFAULT 2,
    "fallbackWindowMinutes" INTEGER NOT NULL DEFAULT 3,
    "fallbackDurationMinutes" INTEGER NOT NULL DEFAULT 30,
    "fallbackUntil" TIMESTAMP(3),
    "fallbackReason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepositProviderConfig_pkey" PRIMARY KEY ("channel")
);

-- CreateTable
CREATE TABLE "DepositLookupFailure" (
    "id" TEXT NOT NULL,
    "referenceKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DepositLookupFailure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepositApprovalPin" (
    "id" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepositApprovalPin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtpChallenge" (
    "id" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "purpose" "OtpPurpose" NOT NULL,
    "requestIp" TEXT,
    "codeHash" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "OtpChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsDeliveryLog" (
    "id" TEXT NOT NULL,
    "providerId" TEXT,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsDeliveryLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DepositLookupFailure_createdAt_idx" ON "DepositLookupFailure"("createdAt");

-- CreateIndex
CREATE INDEX "OtpChallenge_phoneNumber_purpose_createdAt_idx" ON "OtpChallenge"("phoneNumber", "purpose", "createdAt");

-- CreateIndex
CREATE INDEX "OtpChallenge_requestIp_createdAt_idx" ON "OtpChallenge"("requestIp", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Deposit_referenceKey_key" ON "Deposit"("referenceKey");

-- CreateIndex
CREATE INDEX "Deposit_channel_transactionReference_idx" ON "Deposit"("channel", "transactionReference");

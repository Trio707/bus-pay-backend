ALTER TYPE "TopUpSource" ADD VALUE 'MOBILE_MONEY';

CREATE TYPE "DepositChannel" AS ENUM ('MOBILE_MONEY', 'BANK');
CREATE TYPE "MobileMoneyNetwork" AS ENUM ('MPESA', 'AIRTEL_MONEY', 'MIXX_BY_YAS', 'HALOPESA', 'OTHER');
CREATE TYPE "WalletDepositStatus" AS ENUM ('PENDING', 'PROCESSING', 'UNKNOWN', 'COMPLETED', 'FAILED', 'REVERSED');

CREATE TABLE "WalletDeposit" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "walletPublicCode" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "channel" "DepositChannel" NOT NULL DEFAULT 'MOBILE_MONEY',
    "mobileMoneyNetwork" "MobileMoneyNetwork" NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "WalletDepositStatus" NOT NULL DEFAULT 'PENDING',
    "providerReference" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "failureReason" TEXT,
    "topUpId" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processingAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "reversedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WalletDeposit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WalletDeposit_reference_key" ON "WalletDeposit"("reference");
CREATE UNIQUE INDEX "WalletDeposit_providerReference_key" ON "WalletDeposit"("providerReference");
CREATE UNIQUE INDEX "WalletDeposit_topUpId_key" ON "WalletDeposit"("topUpId");
CREATE UNIQUE INDEX "WalletDeposit_walletId_idempotencyKey_key" ON "WalletDeposit"("walletId", "idempotencyKey");
CREATE INDEX "WalletDeposit_status_requestedAt_idx" ON "WalletDeposit"("status", "requestedAt");
CREATE INDEX "WalletDeposit_walletPublicCode_idx" ON "WalletDeposit"("walletPublicCode");
CREATE INDEX "WalletDeposit_provider_requestedAt_idx" ON "WalletDeposit"("provider", "requestedAt");

ALTER TABLE "WalletDeposit" ADD CONSTRAINT "WalletDeposit_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

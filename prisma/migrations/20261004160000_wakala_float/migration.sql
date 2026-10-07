-- CreateEnum
CREATE TYPE "WakalaFloatTransactionType" AS ENUM ('FLOAT_FUNDING', 'PASSENGER_TOPUP', 'CONDUCTOR_WITHDRAWAL', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "WakalaFloatFundingChannel" AS ENUM ('ADMIN', 'PAYMENT_PROVIDER');

-- CreateTable
CREATE TABLE "WakalaFloat" (
    "id" TEXT NOT NULL,
    "agentUserId" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WakalaFloat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WakalaFloatTransaction" (
    "id" TEXT NOT NULL,
    "floatId" TEXT NOT NULL,
    "agentUserId" TEXT NOT NULL,
    "type" "WakalaFloatTransactionType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "balanceBefore" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "reference" TEXT NOT NULL,
    "reason" TEXT,
    "fundingChannel" "WakalaFloatFundingChannel",
    "externalReference" TEXT,
    "topUpId" TEXT,
    "withdrawalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WakalaFloatTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WakalaFloat_agentUserId_key" ON "WakalaFloat"("agentUserId");

-- CreateIndex
CREATE UNIQUE INDEX "WakalaFloatTransaction_reference_key" ON "WakalaFloatTransaction"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "WakalaFloatTransaction_externalReference_key" ON "WakalaFloatTransaction"("externalReference");

-- CreateIndex
CREATE UNIQUE INDEX "WakalaFloatTransaction_topUpId_key" ON "WakalaFloatTransaction"("topUpId");

-- CreateIndex
CREATE UNIQUE INDEX "WakalaFloatTransaction_withdrawalId_key" ON "WakalaFloatTransaction"("withdrawalId");

-- CreateIndex
CREATE INDEX "WakalaFloatTransaction_agentUserId_createdAt_idx" ON "WakalaFloatTransaction"("agentUserId", "createdAt");

-- CreateIndex
CREATE INDEX "WakalaFloatTransaction_floatId_createdAt_idx" ON "WakalaFloatTransaction"("floatId", "createdAt");

-- AddForeignKey
ALTER TABLE "WakalaFloat" ADD CONSTRAINT "WakalaFloat_agentUserId_fkey" FOREIGN KEY ("agentUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WakalaFloatTransaction" ADD CONSTRAINT "WakalaFloatTransaction_floatId_fkey" FOREIGN KEY ("floatId") REFERENCES "WakalaFloat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WakalaFloatTransaction" ADD CONSTRAINT "WakalaFloatTransaction_agentUserId_fkey" FOREIGN KEY ("agentUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

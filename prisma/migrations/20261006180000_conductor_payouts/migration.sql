-- Electronic conductor payouts. Cash-out rows on "Withdrawal" are unchanged.
CREATE TYPE "ConductorPayoutMethod" AS ENUM ('MOBILE_MONEY', 'BANK');
CREATE TYPE "ConductorPayoutStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REVERSED');

CREATE TABLE "ConductorPayout" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "conductorUserId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "method" "ConductorPayoutMethod" NOT NULL,
    "provider" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "accountName" TEXT,
    "status" "ConductorPayoutStatus" NOT NULL DEFAULT 'PENDING',
    "providerReference" TEXT,
    "failureReason" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processingAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConductorPayout_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConductorPayout_reference_key" ON "ConductorPayout"("reference");
CREATE UNIQUE INDEX "ConductorPayout_providerReference_key" ON "ConductorPayout"("providerReference");
CREATE UNIQUE INDEX "ConductorPayout_conductorUserId_idempotencyKey_key" ON "ConductorPayout"("conductorUserId", "idempotencyKey");
CREATE INDEX "ConductorPayout_conductorUserId_requestedAt_idx" ON "ConductorPayout"("conductorUserId", "requestedAt");
CREATE INDEX "ConductorPayout_status_requestedAt_idx" ON "ConductorPayout"("status", "requestedAt");

ALTER TABLE "ConductorPayout" ADD CONSTRAINT "ConductorPayout_conductorUserId_fkey" FOREIGN KEY ("conductorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

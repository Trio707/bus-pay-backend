-- Internal financial ledger. Existing operational tables stay in place.
CREATE TYPE "FinancialAccountType" AS ENUM ('ASSET', 'LIABILITY', 'REVENUE', 'EXPENSE', 'EQUITY', 'CLEARING');
CREATE TYPE "FinancialAccountStatus" AS ENUM ('ACTIVE', 'FROZEN');
CREATE TYPE "LedgerDirection" AS ENUM ('DEBIT', 'CREDIT');
CREATE TYPE "LedgerTransactionStatus" AS ENUM ('POSTED', 'REVERSED');
CREATE TYPE "CommissionType" AS ENUM ('REGISTRATION', 'TOP_UP', 'RENEWAL', 'ADJUSTMENT');
CREATE TYPE "CommissionEntryStatus" AS ENUM ('PENDING', 'SETTLED', 'REVERSED');

CREATE TABLE "FinancialAccount" (
    "id" TEXT NOT NULL,
    "accountCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "FinancialAccountType" NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TZS',
    "status" "FinancialAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "allowNegative" BOOLEAN NOT NULL DEFAULT false,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FinancialAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FinancialAccount_accountCode_key" ON "FinancialAccount"("accountCode");

CREATE TABLE "FinancialLedgerTransaction" (
    "id" TEXT NOT NULL,
    "transactionReference" TEXT NOT NULL,
    "transactionType" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "LedgerTransactionStatus" NOT NULL DEFAULT 'POSTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FinancialLedgerTransaction_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FinancialLedgerTransaction_transactionReference_key" ON "FinancialLedgerTransaction"("transactionReference");
CREATE INDEX "FinancialLedgerTransaction_transactionType_createdAt_idx" ON "FinancialLedgerTransaction"("transactionType", "createdAt");

CREATE TABLE "FinancialLedgerEntry" (
    "id" TEXT NOT NULL,
    "ledgerTransactionId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TZS',
    "referenceType" TEXT,
    "referenceId" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FinancialLedgerEntry_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FinancialLedgerEntry_accountId_createdAt_idx" ON "FinancialLedgerEntry"("accountId", "createdAt");
CREATE INDEX "FinancialLedgerEntry_referenceType_referenceId_idx" ON "FinancialLedgerEntry"("referenceType", "referenceId");

CREATE TABLE "PricingPolicy" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PricingPolicy_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PricingPolicy_code_key" ON "PricingPolicy"("code");

CREATE TABLE "ProviderCost" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "amount" INTEGER,
    "configured" BOOLEAN NOT NULL DEFAULT false,
    "currency" TEXT NOT NULL DEFAULT 'TZS',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProviderCost_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProviderCost_provider_operation_key" ON "ProviderCost"("provider", "operation");

CREATE TABLE "WakalaCommissionAccount" (
    "id" TEXT NOT NULL,
    "agentUserId" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "totalEarned" INTEGER NOT NULL DEFAULT 0,
    "totalPaid" INTEGER NOT NULL DEFAULT 0,
    "lastSettledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WakalaCommissionAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WakalaCommissionAccount_agentUserId_key" ON "WakalaCommissionAccount"("agentUserId");

CREATE TABLE "WakalaCommissionSettlement" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "agentUserId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'READY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WakalaCommissionSettlement_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WakalaCommissionSettlement_reference_key" ON "WakalaCommissionSettlement"("reference");
CREATE INDEX "WakalaCommissionSettlement_agentUserId_createdAt_idx" ON "WakalaCommissionSettlement"("agentUserId", "createdAt");

CREATE TABLE "WakalaCommissionEntry" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "agentUserId" TEXT NOT NULL,
    "type" "CommissionType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "CommissionEntryStatus" NOT NULL DEFAULT 'PENDING',
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "settlementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WakalaCommissionEntry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WakalaCommissionEntry_sourceType_sourceId_type_key" ON "WakalaCommissionEntry"("sourceType", "sourceId", "type");
CREATE INDEX "WakalaCommissionEntry_agentUserId_status_idx" ON "WakalaCommissionEntry"("agentUserId", "status");

ALTER TABLE "FinancialLedgerEntry" ADD CONSTRAINT "FinancialLedgerEntry_ledgerTransactionId_fkey" FOREIGN KEY ("ledgerTransactionId") REFERENCES "FinancialLedgerTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinancialLedgerEntry" ADD CONSTRAINT "FinancialLedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "FinancialAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WakalaCommissionAccount" ADD CONSTRAINT "WakalaCommissionAccount_agentUserId_fkey" FOREIGN KEY ("agentUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WakalaCommissionEntry" ADD CONSTRAINT "WakalaCommissionEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WakalaCommissionAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WakalaCommissionEntry" ADD CONSTRAINT "WakalaCommissionEntry_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "WakalaCommissionSettlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PaymentTransaction" ADD COLUMN "platformFee" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PaymentTransaction" ADD COLUMN "conductorShare" INTEGER;
UPDATE "PaymentTransaction" SET "conductorShare" = "amount" WHERE "conductorShare" IS NULL;
ALTER TABLE "PaymentTransaction" ALTER COLUMN "conductorShare" SET NOT NULL;

ALTER TABLE "Withdrawal" ADD COLUMN "platformFee" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Withdrawal" ADD COLUMN "totalDebit" INTEGER;
UPDATE "Withdrawal" SET "totalDebit" = "amount" WHERE "totalDebit" IS NULL;
ALTER TABLE "Withdrawal" ALTER COLUMN "totalDebit" SET NOT NULL;

ALTER TABLE "ConductorPayout" ADD COLUMN "platformFee" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ConductorPayout" ADD COLUMN "totalDebit" INTEGER;
UPDATE "ConductorPayout" SET "totalDebit" = "amount" WHERE "totalDebit" IS NULL;
ALTER TABLE "ConductorPayout" ALTER COLUMN "totalDebit" SET NOT NULL;

INSERT INTO "FinancialAccount" ("id", "accountCode", "name", "type", "currency", "status", "allowNegative", "balance", "updatedAt")
VALUES
    (gen_random_uuid(), '1000', 'PASSENGER_WALLETS', 'LIABILITY', 'TZS', 'ACTIVE', true, 0, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '2000', 'CONDUCTOR_EARNINGS', 'LIABILITY', 'TZS', 'ACTIVE', true, 0, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '3000', 'WAKALA_FLOAT', 'LIABILITY', 'TZS', 'ACTIVE', true, 0, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '4000', 'BUSPAY_FARE_REVENUE', 'REVENUE', 'TZS', 'ACTIVE', true, 0, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '4100', 'BUSPAY_WITHDRAWAL_FEE_REVENUE', 'REVENUE', 'TZS', 'ACTIVE', true, 0, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '4200', 'OTHER_PLATFORM_REVENUE', 'REVENUE', 'TZS', 'ACTIVE', true, 0, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '5000', 'WAKALA_COMMISSION_EXPENSE', 'EXPENSE', 'TZS', 'ACTIVE', true, 0, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '5100', 'SMS_EXPENSE', 'EXPENSE', 'TZS', 'ACTIVE', true, 0, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '5200', 'CARD_OPERATION_EXPENSE', 'EXPENSE', 'TZS', 'ACTIVE', true, 0, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '5300', 'PAYMENT_PROVIDER_EXPENSE', 'EXPENSE', 'TZS', 'ACTIVE', true, 0, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '6000', 'BUSPAY_OPERATING_ACCOUNT', 'ASSET', 'TZS', 'ACTIVE', true, 0, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '7000', 'SELCOM_SETTLEMENT_CLEARING', 'CLEARING', 'TZS', 'ACTIVE', true, 0, CURRENT_TIMESTAMP);

INSERT INTO "PricingPolicy" ("id", "code", "config", "updatedAt")
VALUES
    (gen_random_uuid(), 'FARE_PLATFORM_RATE_BPS', '{"amount":500}', CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'WAKALA_REGISTRATION_COMMISSION', '{"amount":200}', CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'WAKALA_RENEWAL_COMMISSION', '{"amount":0}', CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'WAKALA_TOPUP_COMMISSION', '{"rateBps":100,"cap":500}', CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'CONDUCTOR_WITHDRAWAL_FEE', '{"tiers":[{"minInclusive":0,"maxExclusive":50000,"fee":1400},{"minInclusive":50000,"maxExclusive":100000,"fee":2100},{"minInclusive":100000,"maxExclusive":200000,"fee":3500},{"minInclusive":200000,"maxExclusive":300000,"fee":4000},{"minInclusive":300000,"maxExclusive":500000,"fee":5000},{"minInclusive":500000,"maxExclusive":1000000,"fee":7000},{"minInclusive":1000000,"maxExclusive":null,"fee":10000}]}', CURRENT_TIMESTAMP);

INSERT INTO "ProviderCost" ("id", "provider", "operation", "amount", "configured", "updatedAt")
VALUES
    (gen_random_uuid(), 'SELCOM', 'PAYOUT', NULL, false, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'SELCOM', 'FARE', NULL, false, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'SELCOM', 'TOPUP', NULL, false, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'SELCOM', 'SMS', NULL, false, CURRENT_TIMESTAMP);

CREATE TYPE "CompanyBankAccountStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'CLOSED');
CREATE TYPE "CompanyFinanceType" AS ENUM ('OWNER_DISTRIBUTION', 'COMPANY_EXPENSE', 'COMPANY_TRANSFER', 'COMPANY_DEPOSIT', 'COMPANY_ADJUSTMENT');
CREATE TYPE "CompanyFinanceStatus" AS ENUM ('PENDING', 'APPROVED', 'PROCESSING', 'COMPLETED', 'FAILED', 'REJECTED', 'REVERSED');

CREATE TABLE "CompanyBankAccount" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "bankName" TEXT,
    "accountNumberMasked" TEXT NOT NULL,
    "ledgerAccountCode" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TZS',
    "status" "CompanyBankAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CompanyBankAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CompanyBankAccount_ledgerAccountCode_key" ON "CompanyBankAccount"("ledgerAccountCode");

CREATE TABLE "CompanyFinanceTransaction" (
    "id" TEXT NOT NULL,
    "type" "CompanyFinanceType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "CompanyFinanceStatus" NOT NULL DEFAULT 'PENDING',
    "description" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "bankAccountId" TEXT,
    "destinationBankAccountId" TEXT,
    "destinationMasked" TEXT,
    "expenseAccountCode" TEXT,
    "requestedByUserId" TEXT NOT NULL,
    "approvedByUserId" TEXT,
    "providerReference" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CompanyFinanceTransaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CompanyFinanceTransaction_reference_key" ON "CompanyFinanceTransaction"("reference");
CREATE UNIQUE INDEX "CompanyFinanceTransaction_idempotencyKey_key" ON "CompanyFinanceTransaction"("idempotencyKey");
CREATE UNIQUE INDEX "CompanyFinanceTransaction_providerReference_key" ON "CompanyFinanceTransaction"("providerReference");
CREATE INDEX "CompanyFinanceTransaction_type_createdAt_idx" ON "CompanyFinanceTransaction"("type", "createdAt");
CREATE INDEX "CompanyFinanceTransaction_status_createdAt_idx" ON "CompanyFinanceTransaction"("status", "createdAt");

ALTER TABLE "CompanyFinanceTransaction" ADD CONSTRAINT "CompanyFinanceTransaction_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "CompanyBankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CompanyFinanceTransaction" ADD CONSTRAINT "CompanyFinanceTransaction_destinationBankAccountId_fkey" FOREIGN KEY ("destinationBankAccountId") REFERENCES "CompanyBankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CompanyFinanceTransaction" ADD CONSTRAINT "CompanyFinanceTransaction_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CompanyFinanceTransaction" ADD CONSTRAINT "CompanyFinanceTransaction_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

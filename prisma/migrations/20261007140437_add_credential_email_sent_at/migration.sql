-- DropForeignKey
ALTER TABLE "CompanyFinanceTransaction" DROP CONSTRAINT "CompanyFinanceTransaction_bankAccountId_fkey";

-- DropForeignKey
ALTER TABLE "CompanyFinanceTransaction" DROP CONSTRAINT "CompanyFinanceTransaction_destinationBankAccountId_fkey";

-- AlterTable
ALTER TABLE "SmsOutbox" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AddForeignKey
ALTER TABLE "CompanyFinanceTransaction" ADD CONSTRAINT "CompanyFinanceTransaction_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "CompanyBankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyFinanceTransaction" ADD CONSTRAINT "CompanyFinanceTransaction_destinationBankAccountId_fkey" FOREIGN KEY ("destinationBankAccountId") REFERENCES "CompanyBankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

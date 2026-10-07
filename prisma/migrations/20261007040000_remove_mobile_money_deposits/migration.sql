DROP TABLE IF EXISTS "WalletDeposit";
DROP TYPE IF EXISTS "DepositChannel";
DROP TYPE IF EXISTS "MobileMoneyNetwork";
DROP TYPE IF EXISTS "WalletDepositStatus";

ALTER TYPE "TopUpSource" RENAME TO "TopUpSource_old";
CREATE TYPE "TopUpSource" AS ENUM ('AGENT_TOPUP', 'INITIAL_LOAD', 'ADMIN_ADJUST');
ALTER TABLE "TopUp" ALTER COLUMN "source" TYPE "TopUpSource" USING ("source"::text::"TopUpSource");
DROP TYPE "TopUpSource_old";

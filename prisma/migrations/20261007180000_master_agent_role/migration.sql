-- New enum values cannot be used in the same transaction that adds them.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'MASTER_AGENT';

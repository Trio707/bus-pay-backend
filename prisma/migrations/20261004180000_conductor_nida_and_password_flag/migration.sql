-- DropIndex
DROP INDEX IF EXISTS "User_nida_key";

-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "User_nida_idx" ON "User"("nida");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "User_role_nida_idx" ON "User"("role", "nida");

-- One NIDA for admin and wakala accounts. Conductors are limited in application code.
CREATE UNIQUE INDEX IF NOT EXISTS "User_nida_staff_key" ON "User"("nida") WHERE "role" IN ('ADMIN', 'AGENT');

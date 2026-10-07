-- The 12-digit serialNumber is the permanent BusPay account number.
-- Lost physical cards keep that number. Only one live card may hold it.
DROP INDEX IF EXISTS "Card_serialNumber_key";

CREATE INDEX "Card_serialNumber_idx" ON "Card"("serialNumber");

CREATE UNIQUE INDEX "Card_serialNumber_live_key"
ON "Card" ("serialNumber")
WHERE status IN ('ACTIVE', 'FROZEN');

CREATE TABLE "ApiIdempotency" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiIdempotency_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApiIdempotency_scope_key_key" ON "ApiIdempotency"("scope", "key");

CREATE INDEX "ApiIdempotency_entityType_entityId_idx" ON "ApiIdempotency"("entityType", "entityId");

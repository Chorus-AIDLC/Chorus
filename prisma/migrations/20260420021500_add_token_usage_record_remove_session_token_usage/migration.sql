-- DropColumn
ALTER TABLE "AgentSession" DROP COLUMN IF EXISTS "tokenUsage";

-- CreateTable
CREATE TABLE "TokenUsageRecord" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "companyUuid" TEXT NOT NULL,
    "agentUuid" TEXT NOT NULL,
    "sessionUuid" TEXT,
    "projectUuid" TEXT,
    "entityType" TEXT,
    "entityUuid" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheCreationInputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadInputTokens" INTEGER NOT NULL DEFAULT 0,
    "sourceSessionId" TEXT,
    "turnTimestamp" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenUsageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TokenUsageRecord_uuid_key" ON "TokenUsageRecord"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "TokenUsageRecord_sourceSessionId_turnTimestamp_key" ON "TokenUsageRecord"("sourceSessionId", "turnTimestamp");

-- CreateIndex
CREATE INDEX "TokenUsageRecord_companyUuid_idx" ON "TokenUsageRecord"("companyUuid");

-- CreateIndex
CREATE INDEX "TokenUsageRecord_agentUuid_idx" ON "TokenUsageRecord"("agentUuid");

-- CreateIndex
CREATE INDEX "TokenUsageRecord_projectUuid_idx" ON "TokenUsageRecord"("projectUuid");

-- CreateIndex
CREATE INDEX "TokenUsageRecord_entityType_entityUuid_idx" ON "TokenUsageRecord"("entityType", "entityUuid");

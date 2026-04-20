-- AlterTable
ALTER TABLE "AgentSession" ADD COLUMN     "tokenUsage" JSONB;

-- CreateTable
CREATE TABLE "ToolUsageEvent" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "companyUuid" TEXT NOT NULL,
    "agentUuid" TEXT NOT NULL,
    "sessionUuid" TEXT,
    "toolName" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'mcp',
    "durationMs" INTEGER NOT NULL,
    "inputSize" INTEGER NOT NULL,
    "outputSize" INTEGER NOT NULL,
    "isError" BOOLEAN NOT NULL DEFAULT false,
    "errorText" TEXT,
    "entityType" TEXT,
    "entityUuid" TEXT,
    "projectUuid" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolUsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ToolUsageEvent_uuid_key" ON "ToolUsageEvent"("uuid");

-- CreateIndex
CREATE INDEX "ToolUsageEvent_companyUuid_createdAt_idx" ON "ToolUsageEvent"("companyUuid", "createdAt");

-- CreateIndex
CREATE INDEX "ToolUsageEvent_agentUuid_createdAt_idx" ON "ToolUsageEvent"("agentUuid", "createdAt");

-- CreateIndex
CREATE INDEX "ToolUsageEvent_sessionUuid_idx" ON "ToolUsageEvent"("sessionUuid");

-- CreateIndex
CREATE INDEX "ToolUsageEvent_entityType_entityUuid_idx" ON "ToolUsageEvent"("entityType", "entityUuid");

-- CreateIndex
CREATE INDEX "ToolUsageEvent_projectUuid_createdAt_idx" ON "ToolUsageEvent"("projectUuid", "createdAt");

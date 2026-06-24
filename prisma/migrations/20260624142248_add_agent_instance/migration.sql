-- AlterTable
ALTER TABLE "DaemonConnection" ADD COLUMN     "agentInstanceUuid" TEXT;

-- CreateTable
CREATE TABLE "AgentInstance" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "companyUuid" TEXT NOT NULL,
    "agentUuid" TEXT NOT NULL,
    "host" TEXT NOT NULL DEFAULT '',
    "cwd" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentInstance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentInstance_uuid_key" ON "AgentInstance"("uuid");

-- CreateIndex
CREATE INDEX "AgentInstance_companyUuid_idx" ON "AgentInstance"("companyUuid");

-- CreateIndex
CREATE INDEX "AgentInstance_agentUuid_idx" ON "AgentInstance"("agentUuid");

-- CreateIndex
CREATE UNIQUE INDEX "AgentInstance_companyUuid_agentUuid_host_cwd_key" ON "AgentInstance"("companyUuid", "agentUuid", "host", "cwd");

-- CreateIndex
CREATE INDEX "DaemonConnection_agentInstanceUuid_idx" ON "DaemonConnection"("agentInstanceUuid");

-- CreateTable
CREATE TABLE "DaemonConnection" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "companyUuid" TEXT NOT NULL,
    "agentUuid" TEXT NOT NULL,
    "clientType" TEXT NOT NULL,
    "clientVersion" TEXT,
    "host" TEXT NOT NULL DEFAULT '',
    "startedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'online',
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DaemonConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DaemonConnection_uuid_key" ON "DaemonConnection"("uuid");

-- CreateIndex
CREATE INDEX "DaemonConnection_companyUuid_idx" ON "DaemonConnection"("companyUuid");

-- CreateIndex
CREATE INDEX "DaemonConnection_agentUuid_idx" ON "DaemonConnection"("agentUuid");

-- CreateIndex
CREATE INDEX "DaemonConnection_status_idx" ON "DaemonConnection"("status");

-- CreateIndex
CREATE INDEX "DaemonConnection_lastSeenAt_idx" ON "DaemonConnection"("lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "DaemonConnection_agentUuid_clientType_host_key" ON "DaemonConnection"("agentUuid", "clientType", "host");

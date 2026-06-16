-- CreateTable
CREATE TABLE "DaemonTaskExecution" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "companyUuid" TEXT NOT NULL,
    "agentUuid" TEXT NOT NULL,
    "connectionUuid" TEXT NOT NULL,
    "taskUuid" TEXT NOT NULL,
    "rootIdeaUuid" TEXT,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DaemonTaskExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DaemonTaskExecution_uuid_key" ON "DaemonTaskExecution"("uuid");

-- CreateIndex
CREATE INDEX "DaemonTaskExecution_connectionUuid_status_idx" ON "DaemonTaskExecution"("connectionUuid", "status");

-- CreateIndex
CREATE INDEX "DaemonTaskExecution_companyUuid_agentUuid_idx" ON "DaemonTaskExecution"("companyUuid", "agentUuid");

-- CreateIndex
CREATE UNIQUE INDEX "DaemonTaskExecution_connectionUuid_taskUuid_key" ON "DaemonTaskExecution"("connectionUuid", "taskUuid");

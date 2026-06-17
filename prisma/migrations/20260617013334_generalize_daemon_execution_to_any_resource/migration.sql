/*
  Warnings:

  - You are about to drop the `DaemonTaskExecution` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE "DaemonTaskExecution";

-- CreateTable
CREATE TABLE "DaemonExecution" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "companyUuid" TEXT NOT NULL,
    "agentUuid" TEXT NOT NULL,
    "connectionUuid" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityUuid" TEXT NOT NULL,
    "rootIdeaUuid" TEXT,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DaemonExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DaemonExecution_uuid_key" ON "DaemonExecution"("uuid");

-- CreateIndex
CREATE INDEX "DaemonExecution_connectionUuid_status_idx" ON "DaemonExecution"("connectionUuid", "status");

-- CreateIndex
CREATE INDEX "DaemonExecution_companyUuid_agentUuid_idx" ON "DaemonExecution"("companyUuid", "agentUuid");

-- CreateIndex
CREATE UNIQUE INDEX "DaemonExecution_connectionUuid_entityType_entityUuid_key" ON "DaemonExecution"("connectionUuid", "entityType", "entityUuid");

-- DropIndex
DROP INDEX "DaemonConnection_agentUuid_clientType_host_key";

-- AlterTable
ALTER TABLE "DaemonConnection" ADD COLUMN     "cwd" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "DaemonConnection_agentUuid_clientType_host_cwd_key" ON "DaemonConnection"("agentUuid", "clientType", "host", "cwd");


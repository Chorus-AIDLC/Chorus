-- AlterTable
ALTER TABLE "DaemonSession" ALTER COLUMN "originConnectionUuid" DROP NOT NULL,
ADD COLUMN "cliLeaseHolder" TEXT,
ADD COLUMN "cliLeaseExpiresAt" TIMESTAMP(3),
ADD COLUMN "cliHost" TEXT,
ADD COLUMN "cliCwd" TEXT,
ADD COLUMN "continuable" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "DaemonSessionTurn" ADD COLUMN "drainedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "DaemonSession_agentUuid_cliHost_idx" ON "DaemonSession"("agentUuid", "cliHost");

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "instructionText" TEXT;

-- CreateTable
CREATE TABLE "DaemonSession" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "companyUuid" TEXT NOT NULL,
    "agentUuid" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "directIdeaUuid" TEXT,
    "originConnectionUuid" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "title" TEXT,
    "lastTurnAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DaemonSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DaemonSessionTurn" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "sessionUuid" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL,
    "promptText" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "executionUuid" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DaemonSessionTurn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DaemonTranscriptMessage" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "turnUuid" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DaemonTranscriptMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DaemonSession_uuid_key" ON "DaemonSession"("uuid");

-- CreateIndex
CREATE INDEX "DaemonSession_companyUuid_agentUuid_idx" ON "DaemonSession"("companyUuid", "agentUuid");

-- CreateIndex
CREATE INDEX "DaemonSession_originConnectionUuid_idx" ON "DaemonSession"("originConnectionUuid");

-- CreateIndex
CREATE UNIQUE INDEX "DaemonSession_agentUuid_sessionId_key" ON "DaemonSession"("agentUuid", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "DaemonSessionTurn_uuid_key" ON "DaemonSessionTurn"("uuid");

-- CreateIndex
CREATE INDEX "DaemonSessionTurn_sessionUuid_status_idx" ON "DaemonSessionTurn"("sessionUuid", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DaemonSessionTurn_sessionUuid_seq_key" ON "DaemonSessionTurn"("sessionUuid", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "DaemonTranscriptMessage_uuid_key" ON "DaemonTranscriptMessage"("uuid");

-- CreateIndex
CREATE INDEX "DaemonTranscriptMessage_turnUuid_seq_idx" ON "DaemonTranscriptMessage"("turnUuid", "seq");

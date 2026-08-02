CREATE TABLE "ProjectAgentCwdPreference" (
  "id" SERIAL NOT NULL,
  "uuid" TEXT NOT NULL,
  "companyUuid" TEXT NOT NULL,
  "userUuid" TEXT NOT NULL,
  "projectUuid" TEXT NOT NULL,
  "agentUuid" TEXT NOT NULL,
  "host" TEXT NOT NULL,
  "cwd" TEXT NOT NULL,
  "anchorAgentInstanceUuid" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProjectAgentCwdPreference_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DaemonDirectoryRequest" (
  "id" SERIAL NOT NULL,
  "uuid" TEXT NOT NULL,
  "companyUuid" TEXT NOT NULL,
  "callerUserUuid" TEXT NOT NULL,
  "agentUuid" TEXT NOT NULL,
  "targetConnectionUuid" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "prefix" TEXT,
  "cwd" TEXT,
  "cursor" TEXT,
  "limit" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "result" JSONB,
  "errorCode" TEXT,
  "deadlineAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DaemonDirectoryRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProjectAgentCwdPreference_uuid_key" ON "ProjectAgentCwdPreference"("uuid");
CREATE UNIQUE INDEX "ProjectAgentCwdPreference_userUuid_projectUuid_agentUuid_key" ON "ProjectAgentCwdPreference"("userUuid", "projectUuid", "agentUuid");
CREATE INDEX "ProjectAgentCwdPreference_companyUuid_projectUuid_idx" ON "ProjectAgentCwdPreference"("companyUuid", "projectUuid");
CREATE INDEX "ProjectAgentCwdPreference_projectUuid_idx" ON "ProjectAgentCwdPreference"("projectUuid");
CREATE INDEX "ProjectAgentCwdPreference_agentUuid_idx" ON "ProjectAgentCwdPreference"("agentUuid");
CREATE INDEX "ProjectAgentCwdPreference_anchorAgentInstanceUuid_idx" ON "ProjectAgentCwdPreference"("anchorAgentInstanceUuid");
CREATE UNIQUE INDEX "DaemonDirectoryRequest_uuid_key" ON "DaemonDirectoryRequest"("uuid");
CREATE INDEX "DaemonDirectoryRequest_companyUuid_callerUserUuid_createdAt_idx" ON "DaemonDirectoryRequest"("companyUuid", "callerUserUuid", "createdAt");
CREATE INDEX "DaemonDirectoryRequest_callerUserUuid_idx" ON "DaemonDirectoryRequest"("callerUserUuid");
CREATE INDEX "DaemonDirectoryRequest_agentUuid_idx" ON "DaemonDirectoryRequest"("agentUuid");
CREATE INDEX "DaemonDirectoryRequest_targetConnectionUuid_status_idx" ON "DaemonDirectoryRequest"("targetConnectionUuid", "status");
CREATE INDEX "DaemonDirectoryRequest_deadlineAt_idx" ON "DaemonDirectoryRequest"("deadlineAt");
ALTER TABLE "DaemonSession" ADD COLUMN "runtimeCwd" TEXT;

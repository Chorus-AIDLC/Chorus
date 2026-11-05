CREATE TABLE "ProjectAgentTeam" (
  "uuid" TEXT NOT NULL,
  "companyUuid" TEXT NOT NULL,
  "projectUuid" TEXT NOT NULL,
  "ownerUuid" TEXT NOT NULL,
  "templateUuid" TEXT,
  "templateName" TEXT NOT NULL,
  "overrides" JSONB NOT NULL DEFAULT '{}',
  "snapshot" JSONB NOT NULL DEFAULT '{}',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "lastLeadAgentUuid" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProjectAgentTeam_pkey" PRIMARY KEY ("uuid")
);
CREATE UNIQUE INDEX "ProjectAgentTeam_projectUuid_ownerUuid_key" ON "ProjectAgentTeam"("projectUuid", "ownerUuid");
CREATE INDEX "ProjectAgentTeam_companyUuid_ownerUuid_idx" ON "ProjectAgentTeam"("companyUuid", "ownerUuid");
CREATE INDEX "ProjectAgentTeam_ownerUuid_idx" ON "ProjectAgentTeam"("ownerUuid");
CREATE INDEX "ProjectAgentTeam_templateUuid_idx" ON "ProjectAgentTeam"("templateUuid");

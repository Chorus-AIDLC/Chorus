CREATE TABLE "AgentTeam" (
    "uuid" TEXT NOT NULL,
    "companyUuid" TEXT NOT NULL,
    "ownerUuid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentTeam_pkey" PRIMARY KEY ("uuid")
);

CREATE TABLE "AgentTeamMember" (
    "uuid" TEXT NOT NULL,
    "teamUuid" TEXT NOT NULL,
    "agentUuid" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    CONSTRAINT "AgentTeamMember_pkey" PRIMARY KEY ("uuid")
);

CREATE INDEX "AgentTeam_companyUuid_ownerUuid_idx" ON "AgentTeam"("companyUuid", "ownerUuid");
CREATE INDEX "AgentTeam_ownerUuid_idx" ON "AgentTeam"("ownerUuid");
CREATE UNIQUE INDEX "AgentTeamMember_teamUuid_role_agentUuid_key" ON "AgentTeamMember"("teamUuid", "role", "agentUuid");
CREATE INDEX "AgentTeamMember_agentUuid_idx" ON "AgentTeamMember"("agentUuid");

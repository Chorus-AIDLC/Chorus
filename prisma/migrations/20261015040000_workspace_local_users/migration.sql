-- Additive only: legacy tenants/users remain OIDC, active, and non-admin.
ALTER TABLE "Company" ADD COLUMN "localAuthEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User"
  ADD COLUMN "authType" TEXT NOT NULL DEFAULT 'oidc',
  ADD COLUMN "username" TEXT,
  ADD COLUMN "localEmail" TEXT,
  ADD COLUMN "passwordHash" TEXT,
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN "workspaceAdmin" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "deletedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "User_companyUuid_username_key" ON "User"("companyUuid", "username");
CREATE UNIQUE INDEX "User_companyUuid_localEmail_key" ON "User"("companyUuid", "localEmail");
CREATE TABLE "UserCredentialToken" (
  "uuid" TEXT NOT NULL,
  "companyUuid" TEXT NOT NULL,
  "userUuid" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "sessionVersion" INTEGER NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserCredentialToken_pkey" PRIMARY KEY ("uuid")
);
CREATE UNIQUE INDEX "UserCredentialToken_tokenHash_key" ON "UserCredentialToken"("tokenHash");
CREATE INDEX "UserCredentialToken_companyUuid_idx" ON "UserCredentialToken"("companyUuid");
CREATE INDEX "UserCredentialToken_userUuid_idx" ON "UserCredentialToken"("userUuid");
CREATE TABLE "LocalUserAudit" (
  "uuid" TEXT NOT NULL,
  "companyUuid" TEXT NOT NULL,
  "actorType" TEXT NOT NULL,
  "actorUuid" TEXT NOT NULL,
  "targetUuid" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LocalUserAudit_pkey" PRIMARY KEY ("uuid")
);
CREATE INDEX "LocalUserAudit_companyUuid_createdAt_idx" ON "LocalUserAudit"("companyUuid", "createdAt");
CREATE INDEX "LocalUserAudit_targetUuid_idx" ON "LocalUserAudit"("targetUuid");

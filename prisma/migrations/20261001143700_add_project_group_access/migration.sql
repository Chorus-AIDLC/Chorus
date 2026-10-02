-- Add group configuration without changing any existing project or grant.
ALTER TABLE "ProjectGroup"
  ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'public',
  ADD COLUMN "createdByUuid" TEXT,
  ADD COLUMN "accessVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ProjectGroup" ADD CONSTRAINT "ProjectGroup_visibility_check"
  CHECK ("visibility" IN ('public', 'private'));

CREATE TABLE "ProjectGroupMember" (
  "id" SERIAL NOT NULL,
  "uuid" TEXT NOT NULL,
  "companyUuid" TEXT NOT NULL,
  "groupUuid" TEXT NOT NULL,
  "userUuid" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "addedByUuid" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProjectGroupMember_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectGroupMember_role_check" CHECK ("role" IN ('viewer', 'editor', 'admin'))
);
CREATE UNIQUE INDEX "ProjectGroupMember_uuid_key" ON "ProjectGroupMember"("uuid");
CREATE UNIQUE INDEX "ProjectGroupMember_groupUuid_userUuid_key" ON "ProjectGroupMember"("groupUuid", "userUuid");
CREATE INDEX "ProjectGroupMember_companyUuid_userUuid_idx" ON "ProjectGroupMember"("companyUuid", "userUuid");
-- Relations follow the repository's relationMode = "prisma". In particular,
-- historical Project.groupUuid values may reference a group that no longer
-- exists; upgrading must neither reject nor rewrite those existing projects.

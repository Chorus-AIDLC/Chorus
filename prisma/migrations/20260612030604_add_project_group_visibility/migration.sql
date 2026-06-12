-- AlterTable
-- New column defaults to 'private' so NEWLY created groups are private.
ALTER TABLE "ProjectGroup" ADD COLUMN     "ownerType" TEXT,
ADD COLUMN     "ownerUuid" TEXT,
ADD COLUMN     "visibility" TEXT NOT NULL DEFAULT 'private';

-- Backfill: all PRE-EXISTING groups become 'shared' so no current grouping
-- becomes inaccessible after this migration. Runs once against rows that
-- existed before the column was added; the column DEFAULT keeps future
-- inserts 'private'.
UPDATE "ProjectGroup" SET "visibility" = 'shared';

-- CreateTable
CREATE TABLE "ProjectGroupMember" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "companyUuid" TEXT NOT NULL,
    "projectGroupUuid" TEXT NOT NULL,
    "memberType" TEXT NOT NULL,
    "memberUuid" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectGroupMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectGroupMember_uuid_key" ON "ProjectGroupMember"("uuid");

-- CreateIndex
CREATE INDEX "ProjectGroupMember_companyUuid_idx" ON "ProjectGroupMember"("companyUuid");

-- CreateIndex
CREATE INDEX "ProjectGroupMember_projectGroupUuid_idx" ON "ProjectGroupMember"("projectGroupUuid");

-- CreateIndex
CREATE INDEX "ProjectGroupMember_memberType_memberUuid_idx" ON "ProjectGroupMember"("memberType", "memberUuid");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectGroupMember_projectGroupUuid_memberType_memberUuid_key" ON "ProjectGroupMember"("projectGroupUuid", "memberType", "memberUuid");

-- CreateIndex
CREATE INDEX "ProjectGroup_visibility_idx" ON "ProjectGroup"("visibility");

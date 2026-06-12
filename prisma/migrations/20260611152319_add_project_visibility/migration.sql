-- AlterTable
-- New column defaults to 'private' so NEWLY created projects are private.
ALTER TABLE "Project" ADD COLUMN     "ownerType" TEXT,
ADD COLUMN     "ownerUuid" TEXT,
ADD COLUMN     "visibility" TEXT NOT NULL DEFAULT 'private';

-- Backfill: all PRE-EXISTING projects become 'shared' so no current work
-- becomes inaccessible after this migration. This UPDATE runs once against rows
-- that existed before the column was added; the column DEFAULT keeps future
-- inserts 'private'.
UPDATE "Project" SET "visibility" = 'shared';

-- CreateTable
CREATE TABLE "ProjectMember" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "companyUuid" TEXT NOT NULL,
    "projectUuid" TEXT NOT NULL,
    "memberType" TEXT NOT NULL,
    "memberUuid" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectMember_uuid_key" ON "ProjectMember"("uuid");

-- CreateIndex
CREATE INDEX "ProjectMember_companyUuid_idx" ON "ProjectMember"("companyUuid");

-- CreateIndex
CREATE INDEX "ProjectMember_projectUuid_idx" ON "ProjectMember"("projectUuid");

-- CreateIndex
CREATE INDEX "ProjectMember_memberType_memberUuid_idx" ON "ProjectMember"("memberType", "memberUuid");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectMember_projectUuid_memberType_memberUuid_key" ON "ProjectMember"("projectUuid", "memberType", "memberUuid");

-- CreateIndex
CREATE INDEX "Project_visibility_idx" ON "Project"("visibility");

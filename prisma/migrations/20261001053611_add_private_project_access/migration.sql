-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "createdByUuid" TEXT,
ADD COLUMN     "visibility" TEXT NOT NULL DEFAULT 'public';

-- CreateTable
CREATE TABLE "ProjectMember" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "companyUuid" TEXT NOT NULL,
    "projectUuid" TEXT NOT NULL,
    "userUuid" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "addedByUuid" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectMember_uuid_key" ON "ProjectMember"("uuid");

-- CreateIndex
CREATE INDEX "ProjectMember_companyUuid_userUuid_idx" ON "ProjectMember"("companyUuid", "userUuid");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectMember_projectUuid_userUuid_key" ON "ProjectMember"("projectUuid", "userUuid");

-- CreateIndex
CREATE INDEX "Project_companyUuid_visibility_idx" ON "Project"("companyUuid", "visibility");

-- Backfill: legacy projects have no creator record. Per owner decision, each
-- existing project's creator/Admin becomes its company's first user
-- (earliest createdAt, tie → lowest id). Companies without users are skipped.
WITH first_user AS (
    SELECT DISTINCT ON ("companyUuid") "companyUuid", "uuid" AS "userUuid"
    FROM "User"
    ORDER BY "companyUuid", "createdAt" ASC, "id" ASC
)
UPDATE "Project" p
SET "createdByUuid" = fu."userUuid"
FROM first_user fu
WHERE p."companyUuid" = fu."companyUuid"
  AND p."createdByUuid" IS NULL;

INSERT INTO "ProjectMember" ("uuid", "companyUuid", "projectUuid", "userUuid", "role", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, p."companyUuid", p."uuid", p."createdByUuid", 'admin', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Project" p
WHERE p."createdByUuid" IS NOT NULL
ON CONFLICT ("projectUuid", "userUuid") DO NOTHING;

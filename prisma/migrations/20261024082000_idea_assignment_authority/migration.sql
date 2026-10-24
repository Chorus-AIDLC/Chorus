ALTER TABLE "Idea"
ADD COLUMN "teamEnrollmentVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "teamGeneration" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "teamEnrolledAt" TIMESTAMP(3),
ADD COLUMN "teamEnrolledByUuid" TEXT,
ADD COLUMN "teamAssignmentChangedAt" TIMESTAMP(3);

CREATE TABLE "IdeaAssignmentAuthorization" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "companyUuid" TEXT NOT NULL,
    "projectUuid" TEXT NOT NULL,
    "ideaUuid" TEXT NOT NULL,
    "agentUuid" TEXT NOT NULL,
    "humanUuid" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceUuid" TEXT NOT NULL,
    "sourceDigest" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedOperationUuid" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IdeaAssignmentAuthorization_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IdeaAssignmentAuthorization_uuid_key" ON "IdeaAssignmentAuthorization"("uuid");
CREATE UNIQUE INDEX "IdeaAssignmentAuthorization_companyUuid_sourceType_sourceUuid_key" ON "IdeaAssignmentAuthorization"("companyUuid", "sourceType", "sourceUuid");
CREATE INDEX "IdeaAssignmentAuthorization_companyUuid_ideaUuid_idx" ON "IdeaAssignmentAuthorization"("companyUuid", "ideaUuid");

CREATE TABLE "IdeaAssignmentOperation" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "companyUuid" TEXT NOT NULL,
    "ideaUuid" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorUuid" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "activityUuid" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IdeaAssignmentOperation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IdeaAssignmentOperation_uuid_key" ON "IdeaAssignmentOperation"("uuid");
CREATE INDEX "IdeaAssignmentOperation_companyUuid_ideaUuid_idx" ON "IdeaAssignmentOperation"("companyUuid", "ideaUuid");

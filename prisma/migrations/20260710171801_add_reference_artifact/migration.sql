-- CreateTable
CREATE TABLE "ReferenceArtifact" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "companyUuid" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetUuid" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "createdByType" TEXT NOT NULL,
    "createdByUuid" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferenceArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReferenceArtifact_uuid_key" ON "ReferenceArtifact"("uuid");

-- CreateIndex
CREATE INDEX "ReferenceArtifact_companyUuid_idx" ON "ReferenceArtifact"("companyUuid");

-- CreateIndex
CREATE INDEX "ReferenceArtifact_targetType_targetUuid_idx" ON "ReferenceArtifact"("targetType", "targetUuid");

-- CreateTable
CREATE TABLE "AcceptanceCriterion" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "taskUuid" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "devStatus" TEXT NOT NULL DEFAULT 'pending',
    "devEvidence" TEXT,
    "devMarkedByType" TEXT,
    "devMarkedBy" TEXT,
    "devMarkedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "evidence" TEXT,
    "markedByType" TEXT,
    "markedBy" TEXT,
    "markedAt" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcceptanceCriterion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AcceptanceCriterion_uuid_key" ON "AcceptanceCriterion"("uuid");

-- CreateIndex
CREATE INDEX "AcceptanceCriterion_taskUuid_idx" ON "AcceptanceCriterion"("taskUuid");

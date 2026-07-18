-- CreateTable
CREATE TABLE "ProjectVisit" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "companyUuid" TEXT NOT NULL,
    "userUuid" TEXT NOT NULL,
    "projectUuid" TEXT NOT NULL,
    "lastVisitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pinnedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectVisit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectVisit_uuid_key" ON "ProjectVisit"("uuid");

-- CreateIndex
CREATE INDEX "ProjectVisit_companyUuid_idx" ON "ProjectVisit"("companyUuid");

-- CreateIndex
CREATE INDEX "ProjectVisit_userUuid_pinnedAt_idx" ON "ProjectVisit"("userUuid", "pinnedAt");

-- CreateIndex
CREATE INDEX "ProjectVisit_userUuid_lastVisitedAt_idx" ON "ProjectVisit"("userUuid", "lastVisitedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectVisit_userUuid_projectUuid_key" ON "ProjectVisit"("userUuid", "projectUuid");

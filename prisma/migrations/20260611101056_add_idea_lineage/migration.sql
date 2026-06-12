-- AlterTable
ALTER TABLE "Idea" ADD COLUMN     "parentUuid" TEXT;

-- CreateIndex
CREATE INDEX "Idea_parentUuid_idx" ON "Idea"("parentUuid");

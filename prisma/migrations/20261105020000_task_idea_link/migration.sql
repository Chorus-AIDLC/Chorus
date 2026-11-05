-- AlterTable
ALTER TABLE "Task" ADD COLUMN "ideaUuid" TEXT;

-- CreateIndex
CREATE INDEX "Task_ideaUuid_idx" ON "Task"("ideaUuid");

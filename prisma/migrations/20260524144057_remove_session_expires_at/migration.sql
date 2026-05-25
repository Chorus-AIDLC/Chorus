/*
  Warnings:

  - You are about to drop the column `expiresAt` on the `AgentSession` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "AgentSession" DROP COLUMN "expiresAt";

-- CreateIndex
CREATE INDEX "AgentSession_lastActiveAt_idx" ON "AgentSession"("lastActiveAt");

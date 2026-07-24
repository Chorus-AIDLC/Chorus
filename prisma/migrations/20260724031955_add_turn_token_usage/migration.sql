-- AlterTable
ALTER TABLE "DaemonSession" ADD COLUMN     "totalInputTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "totalOutputTokens" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "DaemonSessionTurn" ADD COLUMN     "usage" JSONB;

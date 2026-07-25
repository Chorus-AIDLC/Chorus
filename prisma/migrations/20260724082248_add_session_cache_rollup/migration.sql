-- AlterTable
ALTER TABLE "DaemonSession" ADD COLUMN     "totalCacheCreationTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "totalCacheReadTokens" INTEGER NOT NULL DEFAULT 0;

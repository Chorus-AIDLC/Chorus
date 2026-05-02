-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[];

/*
  Warnings:

  - You are about to drop the column `targetCwd` on the `Task` table. All the data in the column will be lost.
  - You are about to drop the column `targetHost` on the `Task` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Task" DROP COLUMN "targetCwd",
DROP COLUMN "targetHost";

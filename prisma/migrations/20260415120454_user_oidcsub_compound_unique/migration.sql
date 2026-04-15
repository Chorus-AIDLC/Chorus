/*
  Warnings:

  - A unique constraint covering the columns `[companyUuid,oidcSub]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "User_oidcSub_key";

-- CreateIndex
CREATE UNIQUE INDEX "User_companyUuid_oidcSub_key" ON "User"("companyUuid", "oidcSub");

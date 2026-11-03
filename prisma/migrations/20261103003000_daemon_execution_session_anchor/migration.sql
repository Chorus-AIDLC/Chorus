ALTER TABLE "DaemonExecution" ADD COLUMN "sessionId" TEXT NOT NULL DEFAULT '';
DROP INDEX "DaemonExecution_connectionUuid_entityType_entityUuid_key";
CREATE UNIQUE INDEX "DaemonExecution_connectionUuid_entityType_entityUuid_sessio_key"
ON "DaemonExecution"("connectionUuid", "entityType", "entityUuid", "sessionId");

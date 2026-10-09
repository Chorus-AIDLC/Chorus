ALTER TABLE "DaemonSessionTurn"
ADD COLUMN "wakeNotificationUuid" TEXT,
ADD COLUMN "wakeTargetConnectionUuid" TEXT,
ADD COLUMN "wakeRuntimeCwd" TEXT;
CREATE UNIQUE INDEX "DaemonSessionTurn_wakeNotificationUuid_key" ON "DaemonSessionTurn"("wakeNotificationUuid");
CREATE INDEX "DaemonSessionTurn_wakeTargetConnectionUuid_status_idx" ON "DaemonSessionTurn"("wakeTargetConnectionUuid", "status");

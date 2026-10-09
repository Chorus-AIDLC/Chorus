ALTER TABLE "Notification"
ADD COLUMN "wakeRecovery" JSONB,
ADD COLUMN "wakeRecoveryPending" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Notification_companyUuid_recipientUuid_wakeRecoveryPending__idx"
ON "Notification"("companyUuid", "recipientUuid", "wakeRecoveryPending", "updatedAt");

ALTER TABLE "DaemonSessionTurn"
ADD COLUMN "wakeNotificationUuid" TEXT,
ADD COLUMN "wakeTargetConnectionUuid" TEXT,
ADD COLUMN "wakeRuntimeCwd" TEXT;
CREATE UNIQUE INDEX "DaemonSessionTurn_wakeNotificationUuid_key" ON "DaemonSessionTurn"("wakeNotificationUuid");
CREATE INDEX "DaemonSessionTurn_wakeTargetConnectionUuid_status_idx" ON "DaemonSessionTurn"("wakeTargetConnectionUuid", "status");

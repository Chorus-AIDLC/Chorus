ALTER TABLE "DaemonSessionTurn"
ADD COLUMN "wakeContext" JSONB,
ADD COLUMN "admissionUuid" TEXT,
ADD COLUMN "admissionConnectionUuid" TEXT,
ADD COLUMN "admissionTurnUuids" JSONB;

CREATE UNIQUE INDEX "DaemonSessionTurn_admissionUuid_key" ON "DaemonSessionTurn"("admissionUuid");

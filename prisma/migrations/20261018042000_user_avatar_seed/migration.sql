BEGIN;
ALTER TABLE "User" ADD COLUMN "avatarSeed" TEXT;
UPDATE "User" SET "avatarSeed" = "uuid";
ALTER TABLE "User" ALTER COLUMN "avatarSeed" SET DEFAULT (gen_random_uuid())::text;
ALTER TABLE "User" ALTER COLUMN "avatarSeed" SET NOT NULL;
COMMIT;

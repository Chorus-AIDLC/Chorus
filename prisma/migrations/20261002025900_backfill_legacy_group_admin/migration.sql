-- Legacy groups use the same first-user rule as legacy projects. Keep the
-- already-deployed group migration unchanged and preserve existing grants.
WITH first_user AS (
  SELECT DISTINCT ON ("companyUuid") "companyUuid", "uuid" AS "userUuid"
  FROM "User"
  ORDER BY "companyUuid", "createdAt" ASC, "id" ASC
), legacy_groups AS (
  SELECT g."uuid", g."companyUuid", fu."userUuid"
  FROM "ProjectGroup" g
  JOIN first_user fu ON fu."companyUuid" = g."companyUuid"
  WHERE g."createdByUuid" IS NULL
), assigned AS (
  INSERT INTO "ProjectGroupMember"
    ("uuid", "companyUuid", "groupUuid", "userUuid", "role", "createdAt", "updatedAt")
  SELECT gen_random_uuid()::text, g."companyUuid", g."uuid", g."userUuid",
    'admin', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM legacy_groups g
  ON CONFLICT ("groupUuid", "userUuid") DO UPDATE
    SET "role" = 'admin', "updatedAt" = CURRENT_TIMESTAMP
    WHERE "ProjectGroupMember"."companyUuid" = EXCLUDED."companyUuid"
  RETURNING "companyUuid", "groupUuid", "userUuid"
)
UPDATE "ProjectGroup" g
SET "createdByUuid" = a."userUuid", "accessVersion" = g."accessVersion" + 1
FROM assigned a
WHERE g."uuid" = a."groupUuid" AND g."companyUuid" = a."companyUuid";

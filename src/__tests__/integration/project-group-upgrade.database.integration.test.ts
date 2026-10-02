import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

const url = process.env.PROJECT_GROUP_DATABASE_URL;

describe.skipIf(!url)("group access migration with legacy assignments — real PostgreSQL", () => {
  let pool: pg.Pool;

  beforeAll(() => { pool = new pg.Pool({ connectionString: url }); });
  afterAll(async () => { await pool?.end(); });

  it("upgrades without rewriting orphan assignments or introducing database foreign keys", async () => {
    const client = await pool.connect();
    const schema = `group_upgrade_${randomUUID().replaceAll("-", "")}`;
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      await client.query(`
        CREATE TABLE "ProjectGroup" ("uuid" TEXT PRIMARY KEY, "companyUuid" TEXT NOT NULL);
        CREATE TABLE "Project" ("uuid" TEXT PRIMARY KEY, "companyUuid" TEXT NOT NULL, "groupUuid" TEXT);
        INSERT INTO "ProjectGroup" VALUES ('existing-group', 'company');
        INSERT INTO "Project" VALUES
          ('valid', 'company', 'existing-group'),
          ('legacy-orphan', 'company', 'missing-group'),
          ('ungrouped', 'company', NULL);
      `);
      await client.query(await readFile(
        "prisma/migrations/20261001143700_add_project_group_access/migration.sql", "utf8",
      ));
      expect((await client.query(`SELECT * FROM "Project" ORDER BY uuid`)).rows).toEqual([
        { uuid: "legacy-orphan", companyUuid: "company", groupUuid: "missing-group" },
        { uuid: "ungrouped", companyUuid: "company", groupUuid: null },
        { uuid: "valid", companyUuid: "company", groupUuid: "existing-group" },
      ]);
      expect((await client.query(`SELECT * FROM "ProjectGroup"`)).rows).toEqual([
        { uuid: "existing-group", companyUuid: "company", visibility: "public", createdByUuid: null, accessVersion: 0 },
      ]);
      expect((await client.query(`
        SELECT conname FROM pg_constraint
        WHERE connamespace = $1::regnamespace AND contype = 'f'
      `, [schema])).rows).toEqual([]);
      await client.query(`
        INSERT INTO "ProjectGroupMember"
          ("uuid", "companyUuid", "groupUuid", "userUuid", "role", "updatedAt")
        VALUES ('member', 'company', 'existing-group', 'user', 'admin', CURRENT_TIMESTAMP)
      `);
      expect((await client.query(`SELECT role FROM "ProjectGroupMember"`)).rows).toEqual([{ role: "admin" }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

const url = process.env.PROJECT_GROUP_DATABASE_URL;
const migration = "prisma/migrations/20261002025900_backfill_legacy_group_admin/migration.sql";

describe.skipIf(!url)("legacy group automatic Admin backfill — real PostgreSQL", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }); });
  afterAll(async () => { await pool?.end(); });

  it("uses each company's first user, preserves grants and projects, and is idempotent", async () => {
    const client = await pool.connect();
    const schema = `group_admin_${randomUUID().replaceAll("-", "")}`;
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      await client.query(`
        CREATE TABLE "User" (
          "id" INTEGER PRIMARY KEY, "uuid" TEXT UNIQUE NOT NULL,
          "companyUuid" TEXT NOT NULL, "createdAt" TIMESTAMP NOT NULL
        );
        CREATE TABLE "ProjectGroup" (
          "uuid" TEXT PRIMARY KEY, "companyUuid" TEXT NOT NULL,
          "createdByUuid" TEXT, "accessVersion" INTEGER NOT NULL DEFAULT 0,
          "visibility" TEXT NOT NULL
        );
        CREATE TABLE "ProjectGroupMember" (
          "uuid" TEXT UNIQUE NOT NULL, "companyUuid" TEXT NOT NULL,
          "groupUuid" TEXT NOT NULL, "userUuid" TEXT NOT NULL, "role" TEXT NOT NULL,
          "createdAt" TIMESTAMP NOT NULL, "updatedAt" TIMESTAMP NOT NULL,
          UNIQUE ("groupUuid", "userUuid")
        );
        CREATE TABLE "Project" (
          "uuid" TEXT PRIMARY KEY, "companyUuid" TEXT NOT NULL,
          "groupUuid" TEXT, "visibility" TEXT NOT NULL
        );
        CREATE TABLE "ProjectMember" (
          "uuid" TEXT PRIMARY KEY, "projectUuid" TEXT NOT NULL,
          "userUuid" TEXT NOT NULL, "role" TEXT NOT NULL
        );
        INSERT INTO "User" VALUES
          (90, 'later-a', 'a', '2025-01-02'),
          (20, 'tie-a', 'a', '2025-01-01'),
          (10, 'first-a', 'a', '2025-01-01'),
          (1, 'first-b', 'b', '2025-01-03');
        INSERT INTO "ProjectGroup" VALUES
          ('empty-a', 'a', NULL, 0, 'public'),
          ('private-a', 'a', NULL, 2, 'private'),
          ('initialized-a', 'a', NULL, 5, 'public'),
          ('legacy-b', 'b', NULL, 0, 'public'),
          ('no-user', 'empty-company', NULL, 0, 'public'),
          ('new-a', 'a', 'later-a', 1, 'private');
        INSERT INTO "ProjectGroupMember" VALUES
          ('promote', 'a', 'private-a', 'first-a', 'viewer', '2025-01-01', '2025-01-01'),
          ('keep-admin', 'a', 'initialized-a', 'later-a', 'admin', '2025-01-01', '2025-01-01'),
          ('keep-viewer', 'a', 'initialized-a', 'tie-a', 'viewer', '2025-01-01', '2025-01-01'),
          ('new-admin', 'a', 'new-a', 'later-a', 'admin', '2025-01-01', '2025-01-01');
        INSERT INTO "Project" VALUES
          ('private-child', 'a', 'private-a', 'private'),
          ('public-child', 'a', 'initialized-a', 'public'),
          ('orphan', 'b', 'missing-group', 'private');
        INSERT INTO "ProjectMember" VALUES
          ('local-admin', 'private-child', 'later-a', 'admin'),
          ('local-viewer', 'private-child', 'tie-a', 'viewer');
      `);
      const projects = (await client.query(`SELECT * FROM "Project" ORDER BY uuid`)).rows;
      const local = (await client.query(`SELECT * FROM "ProjectMember" ORDER BY uuid`)).rows;
      const originalMembers = (await client.query(`SELECT * FROM "ProjectGroupMember" WHERE uuid != 'promote' ORDER BY uuid`)).rows;
      const sql = await readFile(migration, "utf8");
      await client.query(sql);

      expect((await client.query(`SELECT * FROM "ProjectGroup" ORDER BY uuid`)).rows).toEqual([
        { uuid: "empty-a", companyUuid: "a", createdByUuid: "first-a", accessVersion: 1, visibility: "public" },
        { uuid: "initialized-a", companyUuid: "a", createdByUuid: "first-a", accessVersion: 6, visibility: "public" },
        { uuid: "legacy-b", companyUuid: "b", createdByUuid: "first-b", accessVersion: 1, visibility: "public" },
        { uuid: "new-a", companyUuid: "a", createdByUuid: "later-a", accessVersion: 1, visibility: "private" },
        { uuid: "no-user", companyUuid: "empty-company", createdByUuid: null, accessVersion: 0, visibility: "public" },
        { uuid: "private-a", companyUuid: "a", createdByUuid: "first-a", accessVersion: 3, visibility: "private" },
      ]);
      expect((await client.query(`SELECT "companyUuid", "groupUuid", "userUuid", role FROM "ProjectGroupMember" WHERE "userUuid" LIKE 'first-%' ORDER BY "groupUuid"`)).rows).toEqual([
        { companyUuid: "a", groupUuid: "empty-a", userUuid: "first-a", role: "admin" },
        { companyUuid: "a", groupUuid: "initialized-a", userUuid: "first-a", role: "admin" },
        { companyUuid: "b", groupUuid: "legacy-b", userUuid: "first-b", role: "admin" },
        { companyUuid: "a", groupUuid: "private-a", userUuid: "first-a", role: "admin" },
      ]);
      expect((await client.query(`SELECT uuid, role, "createdAt" FROM "ProjectGroupMember" WHERE uuid='promote'`)).rows).toEqual([
        { uuid: "promote", role: "admin", createdAt: new Date("2025-01-01T00:00:00Z") },
      ]);
      expect((await client.query(`SELECT * FROM "ProjectGroupMember" WHERE uuid IN ('keep-admin','keep-viewer','new-admin') ORDER BY uuid`)).rows).toEqual(originalMembers);
      expect((await client.query(`SELECT * FROM "Project" ORDER BY uuid`)).rows).toEqual(projects);
      expect((await client.query(`SELECT * FROM "ProjectMember" ORDER BY uuid`)).rows).toEqual(local);

      const groups = (await client.query(`SELECT * FROM "ProjectGroup" ORDER BY uuid`)).rows;
      const members = (await client.query(`SELECT * FROM "ProjectGroupMember" ORDER BY uuid`)).rows;
      await client.query(sql);
      expect((await client.query(`SELECT * FROM "ProjectGroup" ORDER BY uuid`)).rows).toEqual(groups);
      expect((await client.query(`SELECT * FROM "ProjectGroupMember" ORDER BY uuid`)).rows).toEqual(members);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

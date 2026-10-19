import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsRoot = join(root, "prisma/migrations");
const migrationName = "20261019094000_self_service_display_name";
const baseline = readdirSync(migrationsRoot).filter(name => /^\d/.test(name) && name < migrationName).sort();
const migration = readFileSync(join(migrationsRoot, migrationName, "migration.sql"), "utf8");

test("display name migration preserves legacy data and supports atomic customization", async context => {
  const database = await PGlite.create();
  try {
    for (const name of baseline) await database.exec(readFileSync(join(migrationsRoot, name, "migration.sql"), "utf8"));
    const companyUuid = randomUUID();
    await database.query('INSERT INTO "Company" (uuid, name, "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)', [companyUuid, "Legacy company"]);
    const names = [null, "", "  Legacy  Name  ", "😀".repeat(40), "e\u0301", "Local Admin"];
    for (const [index, name] of names.entries()) {
      await database.query('INSERT INTO "User" (uuid, "companyUuid", "oidcSub", email, name, "avatarUrl", "authType", username, "passwordHash", "workspaceAdmin", "sessionVersion") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)', [
        randomUUID(), companyUuid, `legacy-${index}`, `legacy-${index}@example.test`, name, "https://example.test/avatar.png",
        index === 5 ? "local" : "oidc", index === 5 ? "admin" : null, index === 5 ? "legacy-hash" : null, index === 5, index,
      ]);
    }
    const before = (await database.query('SELECT * FROM "User" ORDER BY id')).rows;

    await context.test("additive migration preserves every existing value and defaults marker to false", async () => {
      await database.exec(migration);
      const after = (await database.query('SELECT * FROM "User" ORDER BY id')).rows;
      assert.deepEqual(after.map(({ nameCustomized, ...row }) => {
        assert.equal(nameCustomized, false);
        return row;
      }), before);
      const metadata = (await database.query("SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'User' AND column_name = 'nameCustomized'")).rows[0];
      assert.deepEqual(metadata, { data_type: "boolean", is_nullable: "NO", column_default: "false" });
    });

    await context.test("legacy inserts omit the flag and null is rejected", async () => {
      const inserted = await database.query('INSERT INTO "User" (uuid, "companyUuid", "oidcSub", name) VALUES ($1, $2, $3, $4) RETURNING "nameCustomized", name', [randomUUID(), companyUuid, "legacy-writer", "x".repeat(60)]);
      assert.deepEqual(inserted.rows, [{ nameCustomized: false, name: "x".repeat(60) }]);
      await assert.rejects(database.query('UPDATE "User" SET "nameCustomized" = NULL WHERE id = $1', [before[0].id]), { code: "23502" });
    });

    for (const order of ["self-first", "oidc-first"]) {
      await context.test(`database predicate protects customization in ${order} order`, async () => {
        const target = before[order === "self-first" ? 0 : 1];
        const selfSave = () => database.query('UPDATE "User" SET name = $1, "nameCustomized" = true WHERE uuid = $2 AND "companyUuid" = $3 AND status = \'active\' AND "deletedAt" IS NULL RETURNING uuid, name', ["Custom name", target.uuid, companyUuid]);
        const oidcSync = () => database.query('UPDATE "User" SET name = $1 WHERE id = $2 AND "companyUuid" = $3 AND "nameCustomized" = false RETURNING name', ["Provider name", target.id, companyUuid]);
        if (order === "self-first") {
          assert.equal((await selfSave()).rows[0].name, "Custom name");
          assert.equal((await oidcSync()).rows.length, 0);
        } else {
          assert.equal((await oidcSync()).rows[0].name, "Provider name");
          await selfSave();
        }
        const persisted = (await database.query('SELECT * FROM "User" WHERE id = $1', [target.id])).rows[0];
        assert.deepEqual(persisted, { ...target, name: "Custom name", nameCustomized: true });
      });
    }

    await context.test("fresh database migration chain supports the new default", async () => {
      await database.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      for (const name of [...baseline, migrationName]) await database.exec(readFileSync(join(migrationsRoot, name, "migration.sql"), "utf8"));
      await database.query('INSERT INTO "Company" (uuid, name, "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)', [companyUuid, "Fresh company"]);
      const inserted = await database.query('INSERT INTO "User" (uuid, "companyUuid", "oidcSub") VALUES ($1, $2, $3) RETURNING "nameCustomized"', [randomUUID(), companyUuid, "fresh"]);
      assert.equal(inserted.rows[0].nameCustomized, false);
    });
  } finally {
    await database.close();
  }
});

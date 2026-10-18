import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test, { after, before } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const legacyRevision = "b3f0097b91971d23e8dbaebdcff39f8cdcc7e798";
const migrationName = "20261018042000_user_avatar_seed";
const migrationsRoot = join(root, "prisma/migrations");
const migration = readFileSync(join(migrationsRoot, migrationName, "migration.sql"), "utf8");
const baseline = readdirSync(migrationsRoot).filter(name => /^\d/.test(name) && name < migrationName).sort();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const engines = process.env.AVATAR_MIGRATION_POSTGRES === "1" ? ["pglite", "postgres17"] : ["pglite"];
let temporaryDirectory;
let LegacyPrismaClient;

function command(program, args, options = {}) {
  return execFileSync(program, args, { cwd: root, encoding: "utf8", timeout: 60_000, ...options }).trim();
}

before(async () => {
  const legacySchema = command("git", ["show", `${legacyRevision}:prisma/schema.prisma`]);
  assert.doesNotMatch(legacySchema, /avatarSeed/);
  mkdirSync(join(root, ".testdata"), { recursive: true });
  temporaryDirectory = mkdtempSync(join(root, ".testdata/avatar-migration-"));
  writeFileSync(join(temporaryDirectory, "package.json"), '{"type":"module"}\n');
  const schemaPath = join(temporaryDirectory, "schema.prisma");
  const configPath = join(temporaryDirectory, "prisma.config.ts");
  writeFileSync(schemaPath, legacySchema.replace(/generator client \{[^}]+\}/, `generator client {
  provider = "prisma-client"
  output = "./client"
  moduleFormat = "esm"
  importFileExtension = "ts"
}`));
  writeFileSync(configPath, `import { defineConfig } from "prisma/config";
export default defineConfig({ schema: ${JSON.stringify(schemaPath)}, datasource: { url: "postgresql://unused:unused@127.0.0.1:1/unused" } });
`);
  command(process.execPath, [join(root, "node_modules/prisma/build/index.js"), "generate", "--schema", schemaPath, "--config", configPath], {
    env: { ...process.env, DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused" },
  });
  ({ PrismaClient: LegacyPrismaClient } = await import(pathToFileURL(join(temporaryDirectory, "client/client.ts")).href));
});

after(() => {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
});

async function startEngine(engine, context) {
  if (engine === "pglite") {
    const database = await PGlite.create();
    const server = new PGLiteSocketServer({ db: database, host: "127.0.0.1", port: 0, maxConnections: 1 });
    try {
      await server.start();
    } catch (error) {
      await database.close();
      throw error;
    }
    return {
      port: Number(server.getServerConn().split(":").at(-1)),
      constraintQuery: (sql, parameters) => database.query(sql, parameters),
      close: async () => { await server.stop(); await database.close(); },
    };
  }

  const name = `chorus-avatar-migration-${process.pid}-${randomUUID().slice(0, 8)}`;
  const container = command("docker", [
    "create", "--pull=never", "--name", name, "--label", "chorus.test=user-avatar-migration",
    "--publish", "127.0.0.1::5432", "--env", "POSTGRES_USER=avatar_test",
    "--env", "POSTGRES_PASSWORD=avatar_test", "--env", "POSTGRES_DB=avatar_test",
    "--tmpfs", "/var/lib/postgresql/data", "postgres:17-alpine",
  ]);
  const close = async () => { command("docker", ["rm", "--force", container]); };
  try {
    command("docker", ["start", container]);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        command("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "avatar_test", "-d", "avatar_test"], { stdio: "pipe" });
        ready = true;
        break;
      } catch {
        await delay(500);
      }
    }
    assert.ok(ready, "disposable PostgreSQL did not become ready within 30 seconds");
    const port = Number(command("docker", ["inspect", "--format", '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', container]));
    context.diagnostic(`Owned disposable container: ${name}; image postgres:17-alpine`);
    return { port, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function applyBaseline(pool) {
  for (const name of baseline) {
    try {
      await pool.query(readFileSync(join(migrationsRoot, name, "migration.sql"), "utf8"));
    } catch (error) {
      throw new Error(`Baseline migration failed: ${name}`, { cause: error });
    }
  }
}

async function createOldWriterUsers(client, companyUuid, phase) {
  const oidc = await client.user.create({ data: {
    companyUuid, oidcSub: `oidc_${phase}`, email: `${phase}.oidc@example.test`, name: "OIDC user",
  } });
  const defaultEmail = `${phase}.default@example.test`;
  const defaultUser = await client.user.upsert({
    where: { companyUuid_oidcSub: { companyUuid, oidcSub: `default_${defaultEmail}` } },
    update: { email: defaultEmail },
    create: { companyUuid, oidcSub: `default_${defaultEmail}`, email: defaultEmail, name: `${phase}.default` },
  });
  const local = await client.$transaction(transaction => transaction.user.create({ data: {
    companyUuid, oidcSub: `local_${randomUUID()}`, authType: "local", username: `${phase}.local`,
    email: `${phase}.local@example.test`, localEmail: `${phase}.local@example.test`,
    name: "Invited local user", workspaceAdmin: true, status: "invited",
  } }));
  for (const user of [oidc, defaultUser, local]) assert.equal(Object.hasOwn(user, "avatarSeed"), false);
  return [oidc, defaultUser, local];
}

async function seedFor(pool, uuid) {
  const result = await pool.query('SELECT "avatarSeed" FROM "User" WHERE uuid = $1', [uuid]);
  return result.rows[0].avatarSeed;
}

async function assertDefaults(pool, users) {
  const seeds = [];
  for (const user of users) {
    const seed = await seedFor(pool, user.uuid);
    assert.match(seed, uuidPattern);
    assert.notEqual(seed, user.uuid);
    seeds.push(seed);
  }
  assert.equal(new Set(seeds).size, users.length);
}

for (const engine of engines) {
  test(`${engine}: avatar migration with actual pre-change Prisma writer`, { timeout: 180_000 }, async context => {
    const backend = await startEngine(engine, context);
    const pool = new pg.Pool({
      host: "127.0.0.1", port: backend.port, database: "avatar_test", user: "avatar_test", password: "avatar_test",
      max: 1, ssl: false, connectionTimeoutMillis: 10_000, statement_timeout: 15_000,
    });
    const writerQueries = [];
    const oldWriter = () => {
      const writer = new LegacyPrismaClient({ adapter: new PrismaPg(pool), log: [{ emit: "event", level: "query" }] });
      writer.$on("query", event => writerQueries.push(event.query));
      return writer;
    };
    let client = oldWriter();
    try {
      const version = (await pool.query("SELECT version() AS version")).rows[0].version;
      if (engine === "postgres17") assert.match(version, /^PostgreSQL 17\./);
      context.diagnostic(`${version}; baseline migrations: ${baseline.length}; legacy schema: ${legacyRevision}`);
      await applyBaseline(pool);
      const company = await client.company.create({ data: { name: "Isolated avatar migration" } });
      const legacyUsers = await createOldWriterUsers(client, company.uuid, "legacy");
      await client.user.update({ where: { uuid: legacyUsers[2].uuid }, data: {
        passwordHash: "opaque-existing-password-hash", sessionVersion: 7, status: "disabled",
        deletedAt: new Date("2026-10-01T00:00:00.000Z"), avatarUrl: "https://example.test/legacy.png",
      } });
      const beforeRows = (await pool.query('SELECT * FROM "User" ORDER BY id')).rows;

      await context.test("failed migration transaction rolls back DDL and leaves the old writer usable", async () => {
        assert.match(migration.trim(), /^BEGIN;[\s\S]*COMMIT;$/);
        const connection = await pool.connect();
        try {
          await assert.rejects(connection.query(migration.replace(/COMMIT;\s*$/, "SELECT 1 / 0; COMMIT;")), { code: "22012" });
          await connection.query("ROLLBACK");
        } finally {
          connection.release();
        }
        const columns = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'User' AND column_name = 'avatarSeed'");
        assert.equal(columns.rowCount, 0);
        assert.deepEqual((await pool.query('SELECT * FROM "User" ORDER BY id')).rows, beforeRows);
        const users = await createOldWriterUsers(client, company.uuid, "failed_migration");
        assert.equal(users.length, 3);
      });

      await context.test("upgrade backfills every legacy row without changing identity or authentication fields", async () => {
        const rows = (await pool.query('SELECT * FROM "User" ORDER BY id')).rows;
        await pool.query(migration);
        const upgraded = (await pool.query('SELECT * FROM "User" ORDER BY id')).rows;
        assert.equal(upgraded.length, rows.length);
        assert.deepEqual(upgraded.map(({ avatarSeed, ...row }) => {
          assert.equal(avatarSeed, row.uuid);
          return row;
        }), rows);
      });

      await context.test("database default and NOT NULL support old OIDC/default/local creation", async () => {
        const constraintQuery = backend.constraintQuery ?? pool.query.bind(pool);
        const metadata = (await pool.query("SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'User' AND column_name = 'avatarSeed'")).rows[0];
        assert.equal(metadata.data_type, "text");
        assert.equal(metadata.is_nullable, "NO");
        assert.match(metadata.column_default, /gen_random_uuid\(\).*::text/);
        await assertDefaults(pool, await createOldWriterUsers(client, company.uuid, "upgraded"));
        await assert.rejects(constraintQuery('INSERT INTO "User" (uuid, "companyUuid", "oidcSub", "avatarSeed") VALUES ($1, $2, $3, NULL)', [randomUUID(), company.uuid, "null_seed"]), { code: "23502" });
        await assert.rejects(constraintQuery('UPDATE "User" SET "avatarSeed" = NULL WHERE uuid = $1', [legacyUsers[0].uuid]), { code: "23502" });
        assert.equal(await seedFor(pool, legacyUsers[0].uuid), legacyUsers[0].uuid);
        assert.equal((await pool.query('SELECT 1 FROM "User" WHERE "oidcSub" = $1', ["null_seed"])).rowCount, 0);
      });

      await context.test("rolling back to the old client preserves saved seeds across profile writes and login upserts", async () => {
        const savedSeeds = legacyUsers.map(() => randomUUID());
        for (const [index, user] of legacyUsers.entries()) {
          await pool.query('UPDATE "User" SET "avatarSeed" = $1 WHERE uuid = $2', [savedSeeds[index], user.uuid]);
        }
        await client.$disconnect();
        client = oldWriter();
        await client.user.update({ where: { uuid: legacyUsers[0].uuid }, data: { email: "renamed.oidc@example.test", name: "Renamed OIDC", oidcSub: "relinked_subject" } });
        await client.user.upsert({
          where: { companyUuid_oidcSub: { companyUuid: company.uuid, oidcSub: legacyUsers[1].oidcSub } },
          update: { email: "renamed.default@example.test" },
          create: { companyUuid: company.uuid, oidcSub: legacyUsers[1].oidcSub },
        });
        await client.user.update({ where: { uuid: legacyUsers[2].uuid }, data: { name: "Renamed local", passwordHash: "replacement-password-hash", sessionVersion: { increment: 1 } } });
        for (const [index, user] of legacyUsers.entries()) assert.equal(await seedFor(pool, user.uuid), savedSeeds[index]);
        await assertDefaults(pool, await createOldWriterUsers(client, company.uuid, "rolled_back_writer"));
      });

      await context.test("fresh database applies the complete migration chain and accepts all old creation shapes", async () => {
        await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
        await applyBaseline(pool);
        await pool.query(migration);
        assert.equal(await client.user.count(), 0);
        const freshCompany = await client.company.create({ data: { name: "Fresh isolated schema" } });
        await assertDefaults(pool, await createOldWriterUsers(client, freshCompany.uuid, "fresh"));
      });

      await context.test("actual generated old-client SQL never references avatarSeed", () => {
        const inserts = writerQueries.filter(query => /INSERT INTO "public"\."User"/.test(query));
        assert.ok(inserts.length >= 15, `expected at least 15 old-client user inserts, got ${inserts.length}`);
        for (const query of writerQueries) assert.doesNotMatch(query, /avatarSeed/);
        context.diagnostic(`Captured ${inserts.length} old-client User INSERT statements; none references avatarSeed`);
      });
    } finally {
      try {
        await client.$disconnect();
      } finally {
        try { await pool.end(); } finally { await backend.close(); }
      }
    }
  });
}

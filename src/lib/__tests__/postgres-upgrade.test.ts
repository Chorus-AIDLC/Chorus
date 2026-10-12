import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(".");
const script = join(root, "deploy/self-host/migrate-pg16-to-17.sh");

describe("offline PostgreSQL upgrade safeguards", () => {
  let fixture: string;
  let backup: string;
  let passwordFile: string;
  let log: string;
  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), "chorus-pg-upgrade-contract-"));
    backup = join(fixture, "backup");
    passwordFile = join(fixture, "password");
    log = join(fixture, "docker.jsonl");
    writeFileSync(passwordFile, "private-fixture-db-password\n", { mode: 0o600 });
    writeFileSync(join(fixture, "docker"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(args) + '\\n');
if (process.env.FAIL && args.join(' ').includes(process.env.FAIL)) process.exit(17);
if (args[0] === 'volume' && args[1] === 'ls') console.log(process.env.VOLUMES || 'source');
if (args[0] === 'volume' && args[1] === 'inspect') console.log(process.env.BAD_OWNER ? 'other-run' : process.env.BACKUP);
if (args[0] === 'ps') console.log(args.includes('--filter') ? process.env.RUNNING || '' : process.env.CONTAINERS || '');
if (args[0] === 'run' && args.includes('cat /source/PG_VERSION')) console.log(process.env.VERSION || '16');
if (args.includes('psql')) {
  const sql = fs.readFileSync(0, 'utf8');
  if (sql.includes('pg_namespace')) console.log(process.env.UNSUPPORTED || '0\\n0\\n0\\n0');
  else if (sql.includes('pg_tables')) console.log(args.includes('target-target17') && process.env.MISMATCH ? 'different' : 'table:public.fixture|3\\nsequence:public.fixture_id_seq|8|true');
}
`, { mode: 0o700 });
  });
  afterEach(() => rmSync(fixture, { recursive: true, force: true }));
  function args() {
    return ["--source-volume", "source", "--target-volume", "target", "--backup-dir", backup,
      "--password-file", passwordFile, "--writers-stopped"];
  }
  function run(overrides: Partial<NodeJS.ProcessEnv> = {}, options = args()) {
    return spawnSync("bash", [script, ...options], {
      encoding: "utf8", timeout: 10000,
      env: { NODE_ENV: "test", PATH: `${fixture}:${process.env.PATH}`, STUB_LOG: log, BACKUP: backup, ...overrides },
    });
  }
  function calls(): string[][] {
    return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  }
  it("dry-run has no Docker calls or filesystem writes", () => {
    expect(run({}, [...args(), "--dry-run"]).status).toBe(0);
    expect(calls()).toEqual([]);
    expect(existsSync(backup)).toBe(false);
  });
  it.each([
    [{ VERSION: "17" }, "Source must be PG16"],
    [{ RUNNING: "running-source" }, "running container"],
    [{ VOLUMES: "source\ntarget" }, "Volume already exists"],
    [{ VOLUMES: "source\ntarget-source16" }, "Volume already exists"],
    [{ VOLUMES: "unrelated" }, "Source volume does not exist"],
    [{ CONTAINERS: "target-target17" }, "Container already exists"],
    [{ CONTAINERS: "target-source16" }, "Container already exists"],
    [{ FAIL: "volume ls" }, ""],
    [{ FAIL: "ps -a" }, ""],
    [{ FAIL: "ps --filter" }, ""],
  ] as const)("fails preflight without creating resources: %j", (overrides, message) => {
    const result = run(overrides);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(existsSync(backup)).toBe(false);
    expect(calls().some(call => call[0] === "create" || call.includes("cp -a /source/. /clone/"))).toBe(false);
  });
  it("requires explicit offline acknowledgement", () => {
    expect(run({}, args().filter(option => option !== "--writers-stopped")).stderr).toContain("--writers-stopped");
    expect(calls()).toEqual([]);
  });
  it("rejects world-readable passwords and an existing backup directory", () => {
    chmodSync(passwordFile, 0o644);
    expect(run().stderr).toContain("chmod 600");
    chmodSync(passwordFile, 0o600);
    mkdirSync(backup);
    expect(run().stderr).toContain("already exists");
    expect(calls()).toEqual([]);
  });
  it("restores into a new isolated volume, protects artifacts and never mounts source writable", () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(statSync(backup).mode & 0o777).toBe(0o700);
    expect(statSync(join(backup, "target-password")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(backup, "source-counts-sequences.txt"), "utf8")).toBe(readFileSync(join(backup, "target-counts-sequences.txt"), "utf8"));
    for (const call of calls()) {
      for (const argument of call.filter(value => value.includes("src=source,"))) expect(argument).toContain(",readonly");
      expect(call.join(" ")).not.toContain("private-fixture-db-password");
      if (["run", "create"].includes(call[0])) expect(call).toContain("none");
      expect(call).not.toContain("rm");
      expect(call).not.toContain("compose");
    }
    expect(calls().find(call => call.includes("pg_restore"))).toEqual(expect.arrayContaining(["--no-owner", "--no-privileges", "--exit-on-error", "--single-transaction"]));
    expect(calls().filter(call => call[0] === "stop")).toEqual([["stop", "target-source16"], ["stop", "target-target17"]]);
    expect(run().stderr).toContain("Backup directory already exists");
  });
  it.each([{ FAIL: "pg_restore" }, { MISMATCH: "1" }, { BAD_OWNER: "1" }, { UNSUPPORTED: "1\n0\n0\n0" }])("retains recovery artifacts and stops only owned helpers on failure: %j", overrides => {
    const result = run(overrides);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("No cutover");
    expect(existsSync(backup)).toBe(true);
    expect(calls().filter(call => call[0] === "stop").every(call => call[1].startsWith("target-"))).toBe(true);
    expect(calls().some(call => call.includes("rm"))).toBe(false);
  });
});

describe.skipIf(process.env.CHORUS_TEST_PG_UPGRADE !== "1")("real isolated PG16 to PG17 migration", () => {
  it("rejects direct reuse, migrates the Chorus schema and fixture data, and preserves a bootable PG16 source", () => {
    const prefix = `chorus-pg-test-${randomUUID()}`;
    const source = `${prefix}-old`;
    const target = `${prefix}-new`;
    const unsupportedTarget = `${prefix}-unsupported`;
    const incompatible = `${prefix}-incompatible`;
    const fixture = mkdtempSync(join(tmpdir(), "chorus-pg-upgrade-live-"));
    const passwordFile = join(fixture, "password");
    const backup = join(fixture, "backup");
    writeFileSync(passwordFile, "fixture-only-password\n", { mode: 0o600 });
    const docker = (options: string[], input?: string) => {
      const result = spawnSync("docker", options, { encoding: "utf8", input, timeout: 120000 });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    const ready = (name: string) => docker(["exec", name, "sh", "-c", "for attempt in $(seq 1 60); do pg_isready -h 127.0.0.1 -U chorus -d chorus && exit 0; sleep 1; done; exit 1"]);
    const query = (name: string, sql: string) => docker(["exec", "-i", "--user", "postgres", name, "psql", "-XqAt", "-v", "ON_ERROR_STOP=1", "-U", "chorus", "-d", "chorus"], sql);
    try {
      docker(["volume", "create", source]);
      docker(["run", "-d", "--name", source, "--network", "none", "--mount", `type=volume,src=${source},dst=/var/lib/postgresql/data`, "-e", "POSTGRES_USER=chorus", "-e", "POSTGRES_DB=chorus", "-e", "POSTGRES_PASSWORD=fixture-only-password", "postgres:16-alpine"]);
      ready(source);
      docker(["run", "--rm", "--pull", "never", "--network", `container:${source}`,
        "--mount", `type=bind,src=${join(root, "prisma")},dst=/app/prisma,readonly`,
        "--entrypoint", "prisma", "-e", "DATABASE_URL=postgresql://chorus:fixture-only-password@127.0.0.1:5432/chorus?sslmode=disable",
        process.env.CHORUS_TEST_MIGRATION_IMAGE || "chorus-local:chorus-local", "migrate", "deploy"]);
      query(source, `CREATE TABLE migration_probe (id serial PRIMARY KEY, body jsonb, labels text[], raw bytea);
INSERT INTO migration_probe(body, labels, raw) VALUES ('{"hello":"世界"}', ARRAY['a','b'], decode('00ff','hex'));
SELECT setval('migration_probe_id_seq', 42, true);`);
      const before = query(source, "SELECT id, body, labels, encode(raw,'hex') FROM migration_probe; SELECT checksum FROM _prisma_migrations ORDER BY migration_name;");
      docker(["stop", source]);
      docker(["volume", "create", incompatible]);
      docker(["run", "--rm", "--network", "none", "--mount", `type=volume,src=${source},dst=/source,readonly`, "--mount", `type=volume,src=${incompatible},dst=/clone`, "--entrypoint", "sh", "postgres:16-alpine", "-c", "cp -a /source/. /clone/"]);
      const direct = spawnSync("docker", ["run", "--rm", "--name", incompatible, "--network", "none", "--mount", `type=volume,src=${incompatible},dst=/var/lib/postgresql/data`, "postgres:17-alpine"], { encoding: "utf8", timeout: 20000 });
      expect(direct.status).not.toBe(0);
      expect(direct.stderr).toContain("database files are incompatible with server");
      const result = spawnSync("bash", [script, "--source-volume", source, "--target-volume", target,
        "--backup-dir", backup, "--password-file", passwordFile, "--writers-stopped"], { encoding: "utf8", timeout: 180000 });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(readFileSync(join(backup, "source-counts-sequences.txt"), "utf8")).toBe(readFileSync(join(backup, "target-counts-sequences.txt"), "utf8"));
      docker(["start", `${target}-target17`]);
      ready(`${target}-target17`);
      expect(query(`${target}-target17`, "SELECT id, body, labels, encode(raw,'hex') FROM migration_probe; SELECT checksum FROM _prisma_migrations ORDER BY migration_name;")).toBe(before);
      expect(query(`${target}-target17`, "INSERT INTO migration_probe DEFAULT VALUES RETURNING id;")).toBe("43");
      docker(["start", source]);
      ready(source);
      expect(query(source, "SELECT id, body, labels, encode(raw,'hex') FROM migration_probe; SELECT checksum FROM _prisma_migrations ORDER BY migration_name;")).toBe(before);
      expect(query(source, "SELECT current_setting('server_version_num')::int / 10000;")).toBe("16");
      query(source, "CREATE SCHEMA pgextra; CREATE TABLE pgextra.probe(id serial); INSERT INTO pgextra.probe DEFAULT VALUES;");
      docker(["stop", source]);
      const unsupported = spawnSync("bash", [script, "--source-volume", source, "--target-volume", unsupportedTarget,
        "--backup-dir", join(fixture, "unsupported-backup"), "--password-file", passwordFile, "--writers-stopped"], { encoding: "utf8", timeout: 120000 });
      expect(unsupported.status).not.toBe(0);
      expect(unsupported.stderr).toContain("Only public-schema databases");
      expect(spawnSync("docker", ["volume", "inspect", unsupportedTarget], { stdio: "ignore" }).status).not.toBe(0);
      docker(["start", source]);
      ready(source);
      expect(query(source, "SELECT count(*) FROM pgextra.probe;")).toBe("1");
    } finally {
      for (const name of [source, incompatible, `${target}-source16`, `${target}-target17`, `${unsupportedTarget}-source16`, `${unsupportedTarget}-target17`]) spawnSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 30000 });
      for (const name of [source, incompatible, target, `${target}-source16`, unsupportedTarget, `${unsupportedTarget}-source16`]) spawnSync("docker", ["volume", "rm", name], { stdio: "ignore", timeout: 30000 });
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 300000);
});

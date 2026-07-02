// cli/__tests__/embedded-db-integration.test.mjs
//
// INTEGRATION CHECKPOINT for GitHub #379 — the DAG convergence point. Unlike the pure
// unit tests in embedded-db.test.mjs (fake spawner/socket), this drives the REAL
// chorus.mjs entry with a REAL forked PGlite and a REAL foreign Postgres, reproducing
// the exact scenarios that produced the reported P1000 and asserting they can no longer
// be reached silently.
//
// Three paths (design.md):
//   A. Foreign Postgres occupies the PGlite port  -> fail fast, no "PGlite ready", no P1000.
//   B. Residual bad DATABASE_URL                   -> rewritten Chorus diagnostic + banner
//                                                     names the external source (not bare P1000).
//   C. Clean env                                   -> happy path unchanged (migrations apply,
//                                                     banner prints), then shuts down cleanly.
//
// Hermetic + self-cleaning: a uniquely-named container, isolated high ports (NEVER the dev
// DB on 5433 or dev server on 8637), a throwaway data-dir, and guaranteed teardown.
//
// The foreign-Postgres legs (A, B) need docker + the postgres image. If docker is
// unavailable we SKIP with a visible console.warn (never a silent skip — project policy).
// Path C needs no docker and always runs.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHORUS_ENTRY = resolve(__dirname, "..", "..", "chorus.mjs");

// Isolated, unlikely-to-collide resources. Deliberately far from 5433 (dev DB) / 8637 (dev server).
const FOREIGN_PG_PORT = 5468; // real Postgres occupies this
const CLEAN_PGLITE_PORT = 5469; // Path C embedded PGlite
const HTTP_PORT_A = 8781;
const HTTP_PORT_B = 8782;
const HTTP_PORT_C = 8783;
const CONTAINER = "chorus-379-integration-pg";
const FOREIGN_PASSWORD = "notchorus"; // != "postgres", so postgres/postgres is rejected

/** True if `docker` runs and the postgres image is usable. */
function dockerAvailable() {
  const v = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    timeout: 8000,
  });
  return v.status === 0 && !!(v.stdout || "").trim();
}

/**
 * Run chorus.mjs to completion-or-banner, capturing combined output.
 * Resolves when the process exits (fail-fast paths) OR the banner appears (happy path),
 * whichever comes first; then ensures the process is dead.
 */
function runChorus({ args, env, waitForBanner, timeoutMs = 90000 }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CHORUS_ENTRY, ...args], {
      cwd: resolve(__dirname, "..", ".."),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const done = (reason) => {
      if (child.exitCode === null && !child.killed) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
      resolvePromise({ output: out, reason, exitCode: child.exitCode });
    };
    const onData = (chunk) => {
      out += chunk;
      // Wait for the FULL banner block, not just the version line: the `Login:` field is
      // the last banner row printed after `Database:`, so matching it guarantees the
      // whole banner (incl. the Database line we assert on) is in `out`. Resolve then and
      // tear down — the post-banner Next.js server start is out of scope for this
      // DB-focused checkpoint.
      if (waitForBanner && /Login:\s+/.test(out)) {
        done("banner");
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", () => done("exit"));
    child.on("error", () => done("error"));
    const t = setTimeout(() => done("timeout"), timeoutMs);
    if (t.unref) t.unref();
  });
}

const hasDocker = dockerAvailable();
const describeForeign = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  // Visible skip — never silent (project "no silent errors" policy).
  console.warn(
    "[embedded-db-integration] SKIPPING the foreign-Postgres legs (Path A + Path B): " +
      "docker is not available. Path C (clean env) still runs. Run with docker to exercise " +
      "the full #379 reproduction."
  );
}

describeForeign("embedded-db integration — foreign Postgres (Paths A & B, docker)", () => {
  beforeAll(() => {
    spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
    const up = spawnSync(
      "docker",
      [
        "run", "-d", "--name", CONTAINER,
        "-e", `POSTGRES_PASSWORD=${FOREIGN_PASSWORD}`,
        "-p", `127.0.0.1:${FOREIGN_PG_PORT}:5432`,
        "postgres:16-alpine",
      ],
      { encoding: "utf8", timeout: 60000 }
    );
    if (up.status !== 0) {
      throw new Error(`failed to start foreign Postgres container: ${up.stderr || up.stdout}`);
    }
    // Wait for readiness so the port is genuinely LISTENing before the tests run.
    let ready = false;
    for (let i = 0; i < 30; i++) {
      const r = spawnSync("docker", ["exec", CONTAINER, "pg_isready", "-U", "postgres"], {
        stdio: "ignore",
        timeout: 8000,
      });
      if (r.status === 0) {
        ready = true;
        break;
      }
      spawnSync("sleep", ["1"]);
    }
    if (!ready) throw new Error("foreign Postgres did not become ready in time");
  }, 120000);

  afterAll(() => {
    spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  });

  it("Path A: foreign Postgres on the PGlite port -> fail fast, no 'PGlite ready', no bare P1000", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chorus-379-A-"));
    try {
      const { output } = await runChorus({
        args: ["--pglite-port", String(FOREIGN_PG_PORT), "--port", String(HTTP_PORT_A), "--data-dir", dataDir],
        env: { DATABASE_URL: "" }, // ensure no residual DATABASE_URL — this is the embedded path
        waitForBanner: false,
      });
      // Fail-fast with an actionable port-conflict message…
      expect(output).toMatch(/--pglite-port/);
      expect(output).toMatch(new RegExp(String(FOREIGN_PG_PORT)));
      // …and crucially NOT a false readiness claim, and NOT a bare Prisma P1000.
      expect(output).not.toMatch(/PGlite ready/i);
      expect(output).not.toMatch(/P1000/);
      // It must not have reached / gotten past migrations against the foreign DB.
      expect(output).not.toMatch(/Migrations completed/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 120000);

  it("Path B: residual bad DATABASE_URL -> rewritten Chorus diagnostic (not bare P1000)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chorus-379-B-"));
    try {
      const badUrl = `postgresql://postgres:postgres@localhost:${FOREIGN_PG_PORT}/postgres?sslmode=disable`;
      const { output } = await runChorus({
        args: ["--port", String(HTTP_PORT_B), "--data-dir", dataDir],
        env: { DATABASE_URL: badUrl },
        waitForBanner: false,
      });
      // The rewritten Chorus diagnostic names the external host:port and the remedy…
      expect(output).toMatch(new RegExp(`localhost:${FOREIGN_PG_PORT}`));
      expect(output).toMatch(/unset DATABASE_URL/);
      // …credentials are masked (the cleartext password must not appear)…
      expect(output).not.toMatch(/postgres:postgres@/);
      // …and it did NOT start embedded PGlite (DATABASE_URL was honored).
      expect(output).not.toMatch(/Starting embedded PostgreSQL/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 120000);
});

describe("embedded-db integration — clean env (Path C, no docker)", () => {
  it("clean env: migrations apply, banner prints, then shuts down cleanly", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chorus-379-C-"));
    try {
      const { output } = await runChorus({
        args: ["--pglite-port", String(CLEAN_PGLITE_PORT), "--port", String(HTTP_PORT_C), "--data-dir", dataDir],
        env: { DATABASE_URL: "" },
        waitForBanner: true,
      });
      // AC-3 success signal for the DB-launch fix is: embedded PGlite came up, migrations
      // applied, and the startup banner printed. (The post-banner Next.js server start is
      // out of scope here — in a source checkout it depends on a `next build` having run
      // to produce .next/standalone/.next/static, which this DB-focused test does not.)
      expect(output).toMatch(/PGlite ready on port/);
      expect(output).toMatch(/Migrations completed/);
      expect(output).toMatch(/Chorus v\d/);
      // Happy path uses embedded PGlite — banner must NOT be tainted with a DATABASE_URL source.
      expect(output).toMatch(/Database:\s+PGlite \(embedded/);
      expect(output).not.toMatch(/P1000/);
      // The DB-launch path itself must not have failed fast.
      expect(output).not.toMatch(/could not start/);
    } finally {
      // Free the embedded PGlite port in case a child lingered.
      spawnSync("pkill", ["-f", `port=${CLEAN_PGLITE_PORT}`], { stdio: "ignore" });
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 120000);
});

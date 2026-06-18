#!/usr/bin/env node

import { execSync, fork } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Subcommand router (client-mode commands)
// ---------------------------------------------------------------------------
// `chorus` with no subcommand (or the existing server flags) launches the
// Next.js server exactly as before. `chorus daemon` and `chorus login` are
// client commands that connect OUT to a remote Chorus server. Their modules are
// lazy-imported so the server-launch path pays no startup cost.

const SUBCOMMANDS = new Set(["daemon", "login"]);

/**
 * Parse `--url` / `--api-key` / `--sigint-timeout` (and `=` forms) + boolean
 * `--yolo` out of an arg list.
 */
function parseClientFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") out.url = argv[i + 1];
    else if (a.startsWith("--url=")) out.url = a.slice("--url=".length);
    else if (a === "--api-key") out.apiKey = argv[i + 1];
    else if (a.startsWith("--api-key=")) out.apiKey = a.slice("--api-key=".length);
    else if (a === "--yolo") out.yolo = true;
    else if (a === "--sigint-timeout") out.sigintTimeout = argv[i + 1];
    else if (a.startsWith("--sigint-timeout=")) out.sigintTimeout = a.slice("--sigint-timeout=".length);
  }
  return out;
}

async function runSubcommand(name, rest) {
  const flags = parseClientFlags(rest);
  if (name === "login") {
    const { runLogin } = await import("./cli/login.mjs");
    return runLogin(flags);
  }
  if (name === "daemon") {
    const { runDaemon } = await import("./cli/daemon.mjs");
    return runDaemon(flags);
  }
  return 1;
}

{
  const sub = process.argv[2];
  if (sub && SUBCOMMANDS.has(sub)) {
    runSubcommand(sub, process.argv.slice(3))
      .then((code) => process.exit(typeof code === "number" ? code : 0))
      .catch((err) => {
        console.error(`Fatal error in 'chorus ${sub}':`, err);
        process.exit(1);
      });
    // Stop the server-launch module body from executing in this process tick.
    // The promise above owns process lifetime from here.
  }
}

const isSubcommand = SUBCOMMANDS.has(process.argv[2]);

// ---------------------------------------------------------------------------
// Dependency resolution (hoist-safe — see issue #214)
// ---------------------------------------------------------------------------
// Use import.meta.resolve so the correct copy of each dependency is found
// regardless of how the user's package manager laid out node_modules
// (nested, hoisted to global root, yarn classic link, etc.).

function resolveOrDie(specifier) {
  try {
    return fileURLToPath(import.meta.resolve(specifier));
  } catch {
    console.error(`\nERROR: cannot resolve dependency "${specifier}".`);
    console.error(`This usually means your package manager hoisted deps in an`);
    console.error(`unexpected layout. Try reinstalling with npm, or see`);
    console.error(`https://github.com/Chorus-AIDLC/Chorus/issues/214 for context.`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// CLI argument parsing (zero dependencies)
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getArg(long, short) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === long || args[i] === short) {
      return args[i + 1] ?? true;
    }
    if (args[i].startsWith(`${long}=`)) {
      return args[i].slice(long.length + 1);
    }
  }
  return undefined;
}

function hasFlag(long, short) {
  return args.includes(long) || args.includes(short);
}

// --help / --version fast paths (skipped when a client subcommand was dispatched —
// e.g. `chorus login --help` belongs to the subcommand, not the server)
if (!isSubcommand && hasFlag("--help", "-h")) {
  const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8"));
  process.stdout.write(`
Chorus v${pkg.version} — AI Agent & Human collaboration platform

USAGE
  chorus [options]                 Start the Chorus server (default)
  chorus login [--url --api-key]   Authenticate as an agent; saves ~/.chorus/daemon.json
  chorus daemon [--url --api-key]  Connect to a remote Chorus server, subscribe to the
                                   agent notification stream, and wake a local headless
                                   Claude Code on task dispatch

SERVER OPTIONS
  -p, --port <port>        HTTP server port             (default: 8637, env: PORT)
  -d, --data-dir <path>    Data directory for PGlite    (default: ~/.chorus-data, env: CHORUS_DATA_DIR)
      --hostname <host>    Bind address                 (default: 0.0.0.0)
      --pglite-port <port> Embedded PGlite port         (default: 5433, env: CHORUS_PGLITE_PORT)
      --use-pglite[=BOOL]  Use embedded PGlite           (default: true; pass =false for external Postgres)
  -h, --help               Show this help message
  -v, --version            Show version number

ENVIRONMENT VARIABLES
  CHORUS_USE_PGLITE        Set to "0" to disable embedded PGlite (default: enabled)
  DATABASE_URL             External PostgreSQL URL (required when --use-pglite=false)
  REDIS_URL                Redis URL for multi-instance pub/sub
  DEFAULT_USER             Auto-create login user email
  DEFAULT_PASSWORD         Auto-create login user password
  NEXTAUTH_SECRET          Session signing secret (auto-generated if unset)
  COOKIE_SECURE            Set to "true" for HTTPS deployments

DAEMON / LOGIN (client mode)
  --url <url>              Remote Chorus server URL      (env: CHORUS_URL)
  --api-key <cho_...>      Agent API key                 (env: CHORUS_API_KEY)
  --yolo                   Give the woken Claude FULL permissions             (env: CHORUS_YOLO=1)
                           (--dangerously-skip-permissions: Bash, file writes,
                           any command). Default is Chorus-MCP-tools-only.
  --sigint-timeout <ms>    Grace window after SIGINT before a forceful kill   (env: CHORUS_DAEMON_SIGINT_TIMEOUT)
                           when an interrupt is received (default: 10000).
                           Also configurable via ~/.chorus/daemon.json sigintTimeoutMs.

  Credential resolution order: flags > CHORUS_URL/CHORUS_API_KEY env >
  ~/.chorus/daemon.json (from 'chorus login') > Claude Code plugin config.

  The daemon spawns the local 'claude' CLI headlessly per task dispatch; it must
  be on PATH. Override with CHORUS_CLAUDE_PATH. By default the woken Claude may
  use only Chorus MCP tools (comment/claim/report/status) — pass --yolo for full
  autonomy (real code-writing AI-DLC), which is dangerous: run it sandboxed.

EXAMPLES
  chorus                                     # Embedded PGlite (default)
  chorus --port 3000                         # Custom port
  chorus --data-dir /var/lib/chorus          # Custom data directory
  DATABASE_URL=postgres://... chorus --use-pglite=false   # External PostgreSQL
  chorus login                               # Interactive: validate key, save credentials
  chorus daemon                              # Connect & wake local Claude Code (Chorus tools only)
  chorus daemon --yolo                       # Full autonomy: woken Claude can run Bash / edit files
  CHORUS_URL=https://... CHORUS_API_KEY=cho_... chorus daemon
`);
  process.exit(0);
}

if (!isSubcommand && hasFlag("--version", "-v")) {
  const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8"));
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const port = Number(getArg("--port", "-p") ?? process.env.PORT ?? 8637);
const dataDir = resolve(
  getArg("--data-dir", "-d") ?? process.env.CHORUS_DATA_DIR ?? join(homedir(), ".chorus-data")
);
const hostname = getArg("--hostname") ?? "0.0.0.0";
const PGLITE_PORT = Number(getArg("--pglite-port") ?? process.env.CHORUS_PGLITE_PORT ?? 5433);

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function waitForTcp(host, tcpPort, maxRetries = 30, intervalMs = 500) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    function tryConnect() {
      attempt++;
      const socket = createConnection({ host, port: tcpPort });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (attempt >= maxRetries) {
          reject(
            new Error(`PGlite failed to start within ${(maxRetries * intervalMs) / 1000} seconds.`)
          );
        } else {
          setTimeout(tryConnect, intervalMs);
        }
      });
    }
    tryConnect();
  });
}

function ensureSecret() {
  const secretPath = join(dataDir, ".secret");
  if (process.env.NEXTAUTH_SECRET) return;
  if (existsSync(secretPath)) {
    process.env.NEXTAUTH_SECRET = readFileSync(secretPath, "utf8").trim();
    return;
  }
  const secret = createHash("sha256")
    .update(randomBytes(32))
    .digest("hex");
  writeFileSync(secretPath, secret, { mode: 0o600 });
  process.env.NEXTAUTH_SECRET = secret;
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

let pgliteProcess = null;

async function main() {
  // 1. Determine database mode
  // --use-pglite means "the database is PGlite-backed" (local or remote).
  // It controls pg.Pool sizing (max=1 to avoid the @electric-sql/pglite-socket
  // cross-handler race), independently of whether the PGlite process is
  // local or remote.
  //
  // Whether to start a local embedded PGlite is decided by DATABASE_URL:
  //   - If DATABASE_URL is set, treat it as a pre-existing DB (PGlite or
  //     real Postgres) and connect to it.
  //   - Otherwise, --use-pglite=true (default) starts an embedded PGlite.
  const usePgliteFlag = getArg("--use-pglite");
  const envFlag = process.env.CHORUS_USE_PGLITE;
  const usePglite =
    usePgliteFlag === "false" || envFlag === "0" || envFlag === "false"
      ? false
      : true;
  const startEmbeddedPglite = usePglite && !process.env.DATABASE_URL;

  if (!usePglite && !process.env.DATABASE_URL) {
    console.error(
      "ERROR: --use-pglite=false requires DATABASE_URL to be set."
    );
    process.exit(1);
  }

  // 2. Signal child processes to pin pg.Pool max=1 when using any PGlite backend.
  if (usePglite) {
    process.env.CHORUS_USE_PGLITE = "1";
  }

  // 3. Start embedded PGlite if requested (no DATABASE_URL pointing at an
  //    external instance).
  if (startEmbeddedPglite) {
    mkdirSync(join(dataDir, "pglite"), { recursive: true });
    console.log(`Starting embedded PostgreSQL (PGlite) on port ${PGLITE_PORT}...`);

    // @electric-sql/pglite-socket does not expose `./dist/scripts/server.js`
    // via the "exports" field, so we resolve the package entry (which IS
    // exported) and derive the sibling server.js path. This remains
    // hoist-safe — see issue #214.
    const pgliteSocketEntry = resolveOrDie("@electric-sql/pglite-socket");
    const serverScript = resolve(dirname(pgliteSocketEntry), "scripts", "server.js");

    pgliteProcess = fork(serverScript, [
      `--db=${join(dataDir, "pglite")}`,
      `--port=${PGLITE_PORT}`,
      "--max-connections=10",
    ], { stdio: "ignore", detached: false });

    pgliteProcess.on("error", (err) => {
      // MODULE_NOT_FOUND is unreachable after the resolveOrDie fix above, but
      // guard against regressions (see issue #214).
      if (err.code === "MODULE_NOT_FOUND") {
        console.error(`PGlite server script unreachable: ${err.message}`);
      } else {
        console.error("PGlite process error:", err.message);
      }
      process.exit(1);
    });

    try {
      await waitForTcp("localhost", PGLITE_PORT);
    } catch (err) {
      console.error(`\nERROR: ${err.message}`);
      console.error(`\nPossible causes:`);
      console.error(`  - Port ${PGLITE_PORT} is already in use`);
      console.error(`  - Corrupt data in ${join(dataDir, "pglite")}/`);
      process.exit(1);
    }

    console.log(`PGlite ready on port ${PGLITE_PORT}.`);
    process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost:${PGLITE_PORT}/postgres?sslmode=disable`;
  }

  // Disable Redis (single-instance in-memory EventBus)
  if (!process.env.REDIS_URL) {
    process.env.REDIS_URL = "";
  }

  // 3. Run database migrations
  console.log("Running database migrations...");
  const prismaBin = resolveOrDie("prisma/build/index.js");
  try {
    execSync(`"${process.execPath}" "${prismaBin}" migrate deploy`, {
      cwd: __dirname,
      stdio: "inherit",
      env: { ...process.env },
    });
  } catch {
    console.error("ERROR: Database migration failed.");
    process.exit(1);
  }
  console.log("Migrations completed.");

  // 4. Generate NEXTAUTH_SECRET if needed
  ensureSecret();

  // 5. Set server environment
  process.env.PORT = String(port);
  process.env.HOSTNAME = hostname;
  process.env.NODE_ENV = "production";
  if (!process.env.LOG_LEVEL) {
    process.env.LOG_LEVEL = "info";
  }
  if (!process.env.COOKIE_SECURE) {
    process.env.COOKIE_SECURE = "false";
  }
  if (!process.env.DEFAULT_USER) {
    process.env.DEFAULT_USER = "admin@chorus.local";
  }
  if (!process.env.DEFAULT_PASSWORD) {
    process.env.DEFAULT_PASSWORD = "chorus";
  }

  // 6. Print banner
  const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8"));
  console.log("");
  console.log(`  Chorus v${pkg.version}`);
  console.log("");
  console.log(`  URL:       http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${port}`);
  console.log(`  Data:      ${dataDir}`);
  const dbLabel = usePglite
    ? (startEmbeddedPglite
        ? "PGlite (embedded, pg.Pool max=1)"
        : "PGlite (external, pg.Pool max=1)")
    : "external PostgreSQL";
  console.log(`  Database:  ${dbLabel}`);
  console.log(`  Redis:     ${process.env.REDIS_URL ? "connected" : "disabled (in-memory EventBus)"}`);
  const maskedPassword = process.env.DEFAULT_PASSWORD === "chorus"
    ? "chorus"
    : "****";
  console.log(`  Login:     ${process.env.DEFAULT_USER} / ${maskedPassword}`);
  console.log("");
  if (usePglite) {
    console.log("  ⚠ PGlite mode pins pg.Pool to max=1 to avoid a cross-handler");
    console.log("    race in @electric-sql/pglite-socket. Concurrent DB traffic is");
    console.log("    serialized — fine for local single-user use, but for multi-user");
    console.log("    or production deployments use a real PostgreSQL: pass");
    console.log("    --use-pglite=false and set DATABASE_URL.");
    console.log("");
  }

  // 7. Ensure static assets are accessible inside standalone directory
  // next build puts .next/static/ and public/ at the project root, but
  // standalone/server.js expects them relative to its own directory.
  // prepack copies them for npm distribution; here we symlink for local dev.
  const standaloneDir = join(__dirname, ".next", "standalone");
  const staticLink = join(standaloneDir, ".next", "static");
  const publicLink = join(standaloneDir, "public");
  const staticSrc = join(__dirname, ".next", "static");
  const publicSrc = join(__dirname, "public");

  if (!existsSync(staticLink) && existsSync(staticSrc)) {
    symlinkSync(staticSrc, staticLink);
  }
  if (!existsSync(publicLink) && existsSync(publicSrc)) {
    symlinkSync(publicSrc, publicLink);
  }

  // 8. Start Next.js standalone server
  // Use pathToFileURL — on Windows, dynamic import() rejects bare drive paths
  // like "C:\…\server.js" with ERR_UNSUPPORTED_ESM_URL_SCHEME. file:// URLs
  // work on every platform.
  process.chdir(standaloneDir);
  await import(pathToFileURL(join(standaloneDir, "server.js")).href);
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\nShutting down...");
  if (pgliteProcess && !pgliteProcess.killed) {
    pgliteProcess.kill("SIGTERM");
    setTimeout(() => {
      if (pgliteProcess && !pgliteProcess.killed) {
        pgliteProcess.kill("SIGKILL");
      }
      process.exit(0);
    }, 3000);
  } else {
    process.exit(0);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => {
  if (pgliteProcess && !pgliteProcess.killed) {
    pgliteProcess.kill("SIGKILL");
  }
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

// Only launch the server when no client subcommand was dispatched above.
if (!isSubcommand) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    if (pgliteProcess && !pgliteProcess.killed) pgliteProcess.kill("SIGTERM");
    process.exit(1);
  });
}

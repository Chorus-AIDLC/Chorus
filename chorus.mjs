#!/usr/bin/env node

import { fork, spawn } from "node:child_process";
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

const SUBCOMMANDS = new Set(["daemon", "login", "init"]);

// Client-subcommand arg parsing + help text live in cli/client-args.mjs so they
// are pure and unit-testable (this entry module runs side effects at import).
import {
  parseClientFlags,
  parseDaemonAction,
  daemonHelpText,
  loginHelpText,
} from "./cli/client-args.mjs";
// Server-only signal-handler installer, guarded so a client subcommand
// (`chorus daemon` / `chorus login`) never registers the server's handlers.
// Pure module → unit-testable without this entry's import-time side effects.
import { installServerSignalHandlers } from "./cli/server-signal-handlers.mjs";
// Embedded-PGlite launch (child-exit capture + port-conflict fail-fast). Extracted
// into a pure, dependency-injected module so it is unit-testable with fakes — see
// cli/embedded-db.mjs and its __tests__ (GitHub #379).
import {
  launchEmbeddedPglite,
  isPrismaAuthFailure,
  formatMigrationAuthDiagnostic,
  maskDbUrl,
} from "./cli/embedded-db.mjs";

/** Read the package version once for help/version output. */
function pkgVersion() {
  return JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")).version;
}

async function runSubcommand(name, rest) {
  // `init` has its own arg parser + help (runInit handles --help itself), so it
  // is dispatched before the shared client-flag/help block below.
  if (name === "init") {
    const { runInit } = await import("./cli/init.mjs");
    return runInit(rest, { version: pkgVersion() });
  }

  const flags = parseClientFlags(rest);

  // Per-subcommand --help / -h fast-path: print subcommand-specific help and
  // exit WITHOUT starting the daemon/login. (The server --help fast-path below
  // is skipped for subcommands, so this is the only place client help is shown.)
  if (flags.help) {
    process.stdout.write(name === "login" ? loginHelpText(pkgVersion()) : daemonHelpText(pkgVersion()));
    return 0;
  }

  if (name === "login") {
    const { runLogin } = await import("./cli/login.mjs");
    return runLogin(flags);
  }
  if (name === "daemon") {
    const action = parseDaemonAction(rest);
    const { runDaemon } = await import("./cli/daemon.mjs");
    // Lifecycle sub-actions (stop/status/restart/logs) are handled by the
    // background-lifecycle module the daemon wires in; `run` is the normal
    // long-lived daemon. We pass the resolved action through so a later task
    // can dispatch it without re-parsing.
    return runDaemon({ ...flags, action });
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
  chorus init [--agents --all]     Detect & configure this machine's coding agents
                                   for Chorus (plugin install + credential seeding)
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
  --chorus-only            Restrict the woken Claude to Chorus MCP tools only  (env: CHORUS_CHORUS_ONLY=1)
                           (comment/claim/report/status — no Bash / file edits).
                           Opt out of the default full-autonomy posture.
  --yolo                   Full autonomy for the woken Claude — the DEFAULT     (env: CHORUS_YOLO=1)
                           (--dangerously-skip-permissions: Bash, file writes,
                           any command). Already on unless --chorus-only is set.
  --sigint-timeout <ms>    Grace window after SIGINT before a forceful kill    (env: CHORUS_DAEMON_SIGINT_TIMEOUT)
                           when an interrupt is received (default: 10000).
                           Also configurable via ~/.chorus/daemon.json sigintTimeoutMs.
  -y, --yes                Non-interactive 'chorus daemon install': skip all install
                           prompts (credentials are still resolved, persisted, and
                           validated; install aborts if none resolve). A non-TTY
                           install behaves as if --yes were passed.

  Credential resolution order: flags > CHORUS_URL/CHORUS_API_KEY env >
  ~/.chorus/daemon.json (from 'chorus login') > Claude Code plugin config.

  The daemon spawns the local 'claude' CLI headlessly per task dispatch; it must
  be on PATH. Override with CHORUS_CLAUDE_PATH. By default the woken Claude runs
  with FULL autonomy (real code-writing AI-DLC), which is dangerous: run it
  sandboxed, or pass --chorus-only to restrict it to Chorus MCP tools.

EXAMPLES
  chorus                                     # Embedded PGlite (default)
  chorus --port 3000                         # Custom port
  chorus --data-dir /var/lib/chorus          # Custom data directory
  DATABASE_URL=postgres://... chorus --use-pglite=false   # External PostgreSQL
  chorus login                               # Interactive: validate key, save credentials
  chorus daemon                              # Connect & wake local Claude Code (full autonomy by default)
  chorus daemon --chorus-only                # Restrict the woken Claude to Chorus MCP tools only
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

// Server-only configuration. Guarded by `!isSubcommand` because these parse
// SERVER flags — notably `-d` is the server's `--data-dir` short alias, which
// collides with the daemon's `-d`/--detach. For `chorus daemon -d`, the
// subcommand dispatch above owns the process; computing `resolve(getArg("--data-dir","-d"))`
// here would see `-d` as a bare boolean `true` and throw `resolve(true)` on the
// same tick, crashing before the daemon detaches. Skipping for subcommands keeps
// the server-flag surface entirely out of the client-command path.
const port = isSubcommand ? 0 : Number(getArg("--port", "-p") ?? process.env.PORT ?? 8637);
const dataDir = isSubcommand
  ? ""
  : resolve(getArg("--data-dir", "-d") ?? process.env.CHORUS_DATA_DIR ?? join(homedir(), ".chorus-data"));
const hostname = isSubcommand ? "" : getArg("--hostname") ?? "0.0.0.0";
const PGLITE_PORT = isSubcommand ? 0 : Number(getArg("--pglite-port") ?? process.env.CHORUS_PGLITE_PORT ?? 5433);

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

// Quick one-shot probe: is something ALREADY listening on host:port right now?
// Used as a pre-flight before forking embedded PGlite so we never fork onto a port
// held by a foreign process (e.g. a real Postgres) and then mistake it for our own
// PGlite. Resolves true if a TCP connection succeeds, false otherwise. (GitHub #379)
function isPortOccupied(host, tcpPort, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port: tcpPort });
    let settled = false;
    const done = (occupied) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(occupied);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
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

    // Launch via the pure, dependency-injected module so a foreign listener on
    // PGLITE_PORT can never be mistaken for our PGlite (GitHub #379): it pre-flights
    // the port, then treats the child exiting before ready as fatal (any exit code,
    // incl. the reproduced EADDRINUSE -> exit 0), instead of trusting "someone is
    // listening". `waitForTcp`/`isPortOccupied` are injected so the logic unit-tests
    // with fakes (see cli/embedded-db.mjs + __tests__).
    const launch = await launchEmbeddedPglite({
      host: "localhost",
      port: PGLITE_PORT,
      fork: () =>
        fork(serverScript, [
          `--db=${join(dataDir, "pglite")}`,
          `--port=${PGLITE_PORT}`,
          "--max-connections=10",
        ], { stdio: "ignore", detached: false }),
      waitForTcp,
      preflightCheck: isPortOccupied,
      logger: console,
    });

    if (!launch.ok) {
      if (launch.reason === "child-exited") {
        // The child (our PGlite) exited before the port was confirmed ready. The most
        // common cause is the port being occupied by another process the child could
        // not bind (EADDRINUSE), which PGlite catches and exits 0 — so key the message
        // off the failure, not the exit code.
        console.error(
          `\nERROR: Embedded PostgreSQL (PGlite) exited before it was ready ` +
            `(exit code ${launch.exitInfo?.code ?? "unknown"}).`
        );
        console.error(`\nMost likely port ${PGLITE_PORT} is already in use by another process`);
        console.error(`(e.g. a real PostgreSQL). Free the port, or run on a different one:`);
        console.error(`  chorus --pglite-port <port>`);
      } else if (launch.reason === "not-ready") {
        console.error(`\nERROR: ${launch.error?.message ?? "PGlite failed to start."}`);
        console.error(`\nPossible causes:`);
        console.error(`  - Port ${PGLITE_PORT} is already in use`);
        console.error(`  - Corrupt data in ${join(dataDir, "pglite")}/`);
      } else if (launch.reason === "child-error") {
        console.error("PGlite process error:", launch.error?.message ?? String(launch.error));
      }
      // reason === "port-occupied" already logged the actionable message in the module.
      process.exit(1);
    }

    pgliteProcess = launch.child;
    process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost:${PGLITE_PORT}/postgres?sslmode=disable`;
  }

  // Disable Redis (single-instance in-memory EventBus)
  if (!process.env.REDIS_URL) {
    process.env.REDIS_URL = "";
  }

  // 3. Run database migrations
  console.log("Running database migrations...");
  const prismaBin = resolveOrDie("prisma/build/index.js");
  // Tee the migrate output: stream each chunk to the parent's stdout/stderr LIVE (so
  // "Applying migration …" progress appears as it happens, not batched at the end) AND
  // buffer it so an authentication failure can be classified and rewritten into an
  // actionable Chorus diagnostic (GitHub #379).
  const migrateResult = await new Promise((resolveMigrate) => {
    const child = spawn(process.execPath, [prismaBin, "migrate", "deploy"], {
      cwd: __dirname,
      env: { ...process.env },
      stdio: ["inherit", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      process.stdout.write(chunk); // live echo
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
      process.stderr.write(chunk); // live echo
    });
    child.on("error", (e) => resolveMigrate({ status: 1, stdout: out, stderr: `${err}\n${e.message}` }));
    child.on("close", (code, signal) => {
      // A null exit code means the migrate process was killed by a signal — treat that
      // as a failure (status 1), never as success, so we don't start the server against
      // a half-migrated database.
      resolveMigrate({ status: code === null ? 1 : code, stdout: out, stderr: err });
    });
  });
  if (migrateResult.status !== 0) {
    const combined = `${migrateResult.stdout ?? ""}\n${migrateResult.stderr ?? ""}`;
    if (isPrismaAuthFailure(combined)) {
      // Replace the bare Prisma P1000 (the last thing the user would otherwise see)
      // with a self-explaining, path-appropriate diagnostic.
      console.error(
        formatMigrationAuthDiagnostic({
          effectiveUrl: process.env.DATABASE_URL,
          startedEmbedded: startEmbeddedPglite,
          pglitePort: PGLITE_PORT,
        })
      );
    } else {
      console.error("ERROR: Database migration failed.");
    }
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
  // When embedded PGlite was skipped, DATABASE_URL is what we actually connected to —
  // name its host:port (credentials masked) so a residual/unintended export is visible
  // rather than silent (GitHub #379, D4). Precedence semantics are unchanged.
  const dbLabel = startEmbeddedPglite
    ? "PGlite (embedded, pg.Pool max=1)"
    : `${usePglite ? "PGlite (external, pg.Pool max=1)" : "external PostgreSQL"} (from DATABASE_URL: ${maskDbUrl(process.env.DATABASE_URL)})`;
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

// Install the server's SIGINT/SIGTERM/exit handlers ONLY on the server launch
// path. On a client subcommand (`chorus daemon` / `chorus login`) this installs
// nothing, so the daemon's OWN graceful shutdown handler is the sole signal
// disposition — otherwise the server's handler (registered first) would pre-empt
// it with a synchronous `process.exit(0)`, leaving the daemon to disconnect
// non-gracefully (stale presence) and printing a misleading bare "Shutting down...".
installServerSignalHandlers({
  isSubcommand,
  processRef: process,
  shutdown,
  cleanupExit: () => {
    if (pgliteProcess && !pgliteProcess.killed) {
      pgliteProcess.kill("SIGKILL");
    }
  },
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

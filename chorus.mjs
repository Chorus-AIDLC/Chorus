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
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

// --help / --version fast paths
if (hasFlag("--help", "-h")) {
  const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8"));
  process.stdout.write(`
Chorus v${pkg.version} — AI Agent & Human collaboration platform

USAGE
  chorus [options]

OPTIONS
  -p, --port <port>        HTTP server port             (default: 8637, env: PORT)
  -d, --data-dir <path>    Data directory for PGlite    (default: ~/.chorus-data, env: CHORUS_DATA_DIR)
      --hostname <host>    Bind address                 (default: 0.0.0.0)
      --pglite-port <port> Embedded PGlite port         (default: 5433, env: CHORUS_PGLITE_PORT)
  -h, --help               Show this help message
  -v, --version            Show version number

ENVIRONMENT VARIABLES
  DATABASE_URL             External PostgreSQL URL (skips embedded PGlite)
  REDIS_URL                Redis URL for multi-instance pub/sub
  DEFAULT_USER             Auto-create login user email
  DEFAULT_PASSWORD         Auto-create login user password
  NEXTAUTH_SECRET          Session signing secret (auto-generated if unset)
  COOKIE_SECURE            Set to "true" for HTTPS deployments

EXAMPLES
  chorus                                     # Start with defaults
  chorus --port 3000                         # Custom port
  chorus --data-dir /var/lib/chorus          # Custom data directory
  DATABASE_URL=postgres://... chorus         # Use external PostgreSQL
`);
  process.exit(0);
}

if (hasFlag("--version", "-v")) {
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
  // 1. Ensure data directory
  mkdirSync(join(dataDir, "pglite"), { recursive: true });

  // 2. Determine database mode
  const useExternalDb = !!process.env.DATABASE_URL;

  if (!useExternalDb) {
    // Start embedded PGlite
    console.log(`Starting embedded PostgreSQL (PGlite) on port ${PGLITE_PORT}...`);

    const serverScript = join(
      __dirname,
      "node_modules",
      "@electric-sql",
      "pglite-socket",
      "dist",
      "scripts",
      "server.js"
    );

    pgliteProcess = fork(serverScript, [
      `--db=${join(dataDir, "pglite")}`,
      `--port=${PGLITE_PORT}`,
      "--max-connections=10",
    ], { stdio: "ignore", detached: false });

    pgliteProcess.on("error", (err) => {
      console.error("PGlite process error:", err.message);
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
  const prismaPath = join(__dirname, "node_modules", ".bin", "prisma");
  try {
    execSync(`"${prismaPath}" migrate deploy`, {
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
  console.log(`  Database:  ${useExternalDb ? "external PostgreSQL" : "PGlite (embedded)"}`);
  console.log(`  Redis:     ${process.env.REDIS_URL ? "connected" : "disabled (in-memory EventBus)"}`);
  const maskedPassword = process.env.DEFAULT_PASSWORD === "chorus"
    ? "chorus"
    : "****";
  console.log(`  Login:     ${process.env.DEFAULT_USER} / ${maskedPassword}`);
  console.log("");

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
  process.chdir(standaloneDir);
  await import(join(standaloneDir, "server.js"));
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

main().catch((err) => {
  console.error("Fatal error:", err);
  if (pgliteProcess && !pgliteProcess.killed) pgliteProcess.kill("SIGTERM");
  process.exit(1);
});

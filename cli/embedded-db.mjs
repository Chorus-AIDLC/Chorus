// cli/embedded-db.mjs
// Embedded PGlite launch logic, extracted out of chorus.mjs (GitHub #379).
//
// Why this module exists — the bug:
//   chorus.mjs used to fork the PGlite child with { stdio: "ignore" }, attach only
//   .on("error") (which fires ONLY on spawn failure), then trust waitForTcp — which
//   answers "is *someone* listening on this port?", NOT "is it *our* PGlite?". When a
//   real Postgres already occupied the port (default 5433), the forked PGlite child
//   died of EADDRINUSE — but it catches that and exits with code 0 (a clean shutdown),
//   so .on("error") never fired and its output was swallowed by stdio:"ignore". The
//   launcher then connected to the FOREIGN Postgres, printed a false "PGlite ready",
//   and `prisma migrate deploy` failed authentication with a bare Prisma P1000.
//
// The fix is defense-in-depth, both layers pure + dependency-injected so they unit-test
// with fakes (server-signal-handlers.mjs precedent — no real process spawning, no
// import-time side effects):
//   1. Pre-flight port-occupancy probe — before forking, check whether the port is
//      already held. If so, FAIL FAST with an actionable message (no fork, no false
//      "ready", no silent mis-connect).
//   2. Exit-latch — after forking, race the child's "exit"/"error" against port-ready.
//      If the child exits before readiness is confirmed, for ANY exit code (including
//      the reproduced EADDRINUSE -> exit 0), the launch is FATAL. "someone is listening"
//      is no longer sufficient evidence that our embedded PGlite is up.
//
// No automatic port bumping (out of scope for #379 — elaboration chose fail-fast).

/**
 * Format the fail-fast message shown when the embedded PGlite port is occupied.
 * @param {number} port
 * @returns {string}
 */
export function formatPortConflictMessage(port) {
  return (
    `ERROR: Embedded PostgreSQL (PGlite) could not start — port ${port} is already in use.\n` +
    `Another process (often a real PostgreSQL) is occupying it. Free the port, or run\n` +
    `Chorus on a different embedded port:  chorus --pglite-port <port>`
  );
}

/** True when a child process has already terminated (exit code recorded). */
function childHasExited(child) {
  return child.exitCode !== null && child.exitCode !== undefined;
}

/**
 * Classify migrate output as a Prisma authentication failure (P1000).
 *
 * Matches the stable error CODE token first, then the human phrase as a fallback,
 * so it survives message drift across Prisma versions. Deliberately narrow: it must
 * NOT fire on other migration errors (P3009 failed migration, P1001 can't-reach, etc.)
 * — those keep chorus.mjs's existing generic "Database migration failed" path.
 * Verified against the installed Prisma 7.3.0 surface text (GitHub #379).
 *
 * @param {string|undefined|null} output  combined stdout+stderr of `prisma migrate deploy`
 * @returns {boolean}
 */
export function isPrismaAuthFailure(output) {
  if (!output) return false;
  const text = String(output);
  // P1000 is Prisma's dedicated auth-failure code — the most stable signal.
  if (/\bP1000\b/.test(text)) return true;
  // Fallback phrase (covers adapter-surfaced errors that omit the bare code token).
  if (/Authentication failed against (the )?database server/i.test(text)) return true;
  return false;
}

/**
 * Mask credentials in a Postgres connection URL, preserving host:port (+db) for
 * diagnostics. Falls back to a naive user:pass@ strip if URL parsing fails, and to a
 * placeholder for empty input.
 *
 * @param {string|undefined|null} url
 * @returns {string}
 */
export function maskDbUrl(url) {
  if (!url) return "(unknown database)";
  const raw = String(url);
  try {
    const u = new URL(raw);
    const auth = u.username ? `${u.username}:***@` : "";
    const db = u.pathname && u.pathname !== "/" ? u.pathname : "";
    return `${u.protocol}//${auth}${u.host}${db}`;
  } catch {
    // Best-effort: strip a user:pass@ segment if present.
    return raw.replace(/\/\/[^@/]*@/, "//***@");
  }
}

/** Extract just host:port from a connection URL for terse messages. */
function hostPortOf(url) {
  if (!url) return "the database";
  try {
    return new URL(String(url)).host || "the database";
  } catch {
    const m = String(url).match(/@([^/?]+)/);
    return m ? m[1] : "the database";
  }
}

/**
 * Build the Chorus-friendly diagnostic shown (as the FINAL output) when
 * `prisma migrate deploy` fails authentication. The remedy depends on WHY we're
 * pointed at that database:
 *   - embedded path (no external DATABASE_URL): the port is likely occupied by another
 *     PostgreSQL — suggest `chorus --pglite-port <port>`.
 *   - external path (DATABASE_URL set): name the external host:port and suggest
 *     `unset DATABASE_URL` if it was unintended.
 * Credentials are always masked.
 *
 * @param {object} params
 * @param {string}  params.effectiveUrl    the DATABASE_URL actually used for migration
 * @param {boolean} params.startedEmbedded  true if we launched embedded PGlite ourselves
 * @param {number}  params.pglitePort       the embedded port (for the --pglite-port hint)
 * @returns {string}
 */
export function formatMigrationAuthDiagnostic({ effectiveUrl, startedEmbedded, pglitePort }) {
  const masked = maskDbUrl(effectiveUrl);
  const hostPort = hostPortOf(effectiveUrl);
  const lines = [
    "",
    "ERROR: Database migration failed — the database server rejected the credentials.",
    `Connected to ${masked}, but authentication failed (Prisma P1000).`,
    "",
  ];
  if (startedEmbedded) {
    lines.push(
      `This usually means port ${pglitePort} is occupied by another PostgreSQL, so Chorus`,
      `connected to it instead of its own embedded database. Free the port, or run on a`,
      `different one:  chorus --pglite-port <port>`
    );
  } else {
    lines.push(
      `Chorus used the DATABASE_URL from your environment (${hostPort}) instead of its`,
      `embedded database. If that was not intended, clear it and re-run:  unset DATABASE_URL`
    );
  }
  return lines.join("\n");
}

/**
 * Launch the embedded PGlite child and confirm it is genuinely OUR process that is
 * ready — not a foreign listener on the same port.
 *
 * Pure w.r.t. its injected dependencies: `fork`, `waitForTcp`, `preflightCheck`,
 * `logger`. No process global is touched here; the caller (chorus.mjs) wires the real
 * implementations and decides how to exit on failure.
 *
 * @param {object} params
 * @param {string}   params.host            host to probe for readiness (e.g. "localhost")
 * @param {number}   params.port            embedded PGlite port
 * @param {() => { on: Function, kill?: Function, exitCode: number|null, killed?: boolean }} params.fork
 *   forks the PGlite server child and returns a ChildProcess-like object
 * @param {(host: string, port: number) => Promise<void>} params.waitForTcp
 *   resolves when the port accepts a TCP connection, rejects on timeout
 * @param {(host: string, port: number) => Promise<boolean>} params.preflightCheck
 *   resolves true if the port is ALREADY occupied before we fork (foreign listener)
 * @param {{ log: Function, error: Function }} params.logger
 * @returns {Promise<
 *   | { ok: true, child: object }
 *   | { ok: false, reason: "port-occupied", port: number }
 *   | { ok: false, reason: "child-exited", exitInfo: { code: number|null, signal: string|null } }
 *   | { ok: false, reason: "child-error", error: Error }
 *   | { ok: false, reason: "not-ready", error: Error }
 * >}
 */
export async function launchEmbeddedPglite({ host, port, fork, waitForTcp, preflightCheck, logger }) {
  // Layer 1 — pre-flight: never fork onto an already-occupied port.
  const occupied = await preflightCheck(host, port);
  if (occupied) {
    logger.error(formatPortConflictMessage(port));
    return { ok: false, reason: "port-occupied", port };
  }

  const child = fork();

  // The child may have died synchronously during/just after fork (its exit code is
  // then already recorded even if our "exit" listener attaches a tick too late).
  if (childHasExited(child)) {
    return {
      ok: false,
      reason: "child-exited",
      exitInfo: { code: child.exitCode, signal: null },
    };
  }

  // Layer 2 — latch the child's terminal events, then race them against readiness.
  // A dead child ALWAYS beats a "someone is listening" probe: that is the #379 guard.
  let exitInfo = null; // { code, signal } once the child exits
  let spawnError = null;
  let readyError = null;

  const childDied = new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      exitInfo = { code, signal };
      resolve("exit");
    });
    child.on("error", (err) => {
      spawnError = err;
      resolve("error");
    });
  });

  const readied = waitForTcp(host, port).then(
    () => "ready",
    (err) => {
      readyError = err;
      return "not-ready";
    }
  );

  const outcome = await Promise.race([childDied, readied]);

  // Re-check the latches regardless of who won the race — the child dying is fatal
  // even if the port-ready probe also resolved (e.g. against a foreign listener).
  if (exitInfo || childHasExited(child)) {
    return {
      ok: false,
      reason: "child-exited",
      exitInfo: exitInfo || { code: child.exitCode ?? null, signal: null },
    };
  }
  if (spawnError) {
    return { ok: false, reason: "child-error", error: spawnError };
  }
  if (outcome === "not-ready") {
    // Readiness timed out but the child is (as far as we know) still alive — don't leak it.
    if (child.kill && !child.killed) child.kill("SIGTERM");
    return { ok: false, reason: "not-ready", error: readyError };
  }

  // outcome === "ready" AND the child has not exited → genuinely our PGlite.
  logger.log(`PGlite ready on port ${port}.`);
  return { ok: true, child };
}

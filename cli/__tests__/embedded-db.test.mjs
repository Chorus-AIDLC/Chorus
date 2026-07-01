// cli/__tests__/embedded-db.test.mjs
// Regression tests for GitHub #379 — the embedded PGlite launch used to mistake a
// foreign process listening on the PGlite port (default 5433) for our own PGlite:
// it forked the child with stdio:"ignore", attached only .on("error") (spawn
// failure), then trusted waitForTcp ("is *someone* listening?"). A real Postgres
// on the port therefore produced a false "PGlite ready", a connection to the wrong
// DB, and a Prisma P1000 at migrate time.
//
// The hardened launcher (cli/embedded-db.mjs) is PURE + dependency-injected so we
// can drive it with a fake spawner + fake TCP probe — no real process spawning, no
// import-time side effects (server-signal-handlers.test.mjs pattern). Two layered
// guards: (1) a pre-flight port-occupancy probe that fails fast BEFORE forking onto
// an occupied port; (2) an exit-latch that treats the child exiting before the port
// is ready as fatal for ANY exit code (incl. the reproduced EADDRINUSE -> exit 0).
import { describe, it, expect, vi } from "vitest";
import {
  launchEmbeddedPglite,
  formatPortConflictMessage,
  isPrismaAuthFailure,
  maskDbUrl,
  formatMigrationAuthDiagnostic,
} from "../embedded-db.mjs";

/** A minimal ChildProcess-like fake: records listeners, lets tests fire events. */
function fakeChild() {
  const listeners = {};
  return {
    exitCode: null,
    killed: false,
    on(event, fn) {
      (listeners[event] ||= []).push(fn);
      return this;
    },
    /** test helper: how many listeners are attached for an event */
    _listenerCount(event) {
      return (listeners[event] || []).length;
    },
    kill() {
      this.killed = true;
      return true;
    },
    /** test helper: simulate the child exiting */
    _emitExit(code, signal = null) {
      this.exitCode = code;
      for (const fn of listeners.exit || []) fn(code, signal);
    },
    /** test helper: simulate a spawn error */
    _emitError(err) {
      for (const fn of listeners.error || []) fn(err);
    },
  };
}

/**
 * Wait until the launcher has attached at least one listener for `event` on the
 * child — i.e. it has passed `await preflightCheck` and `fork()`. Polls the fake's
 * recorded listeners across microtasks so tests fire child events at a realistic
 * point (a real child dies AFTER fork + listener attach, never before).
 */
async function waitForListeners(child, event) {
  for (let i = 0; i < 50; i++) {
    if (child._listenerCount(event) > 0) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`timed out waiting for a '${event}' listener to attach`);
}

/** A fake logger recording every line. */
function fakeLogger() {
  const lines = [];
  return {
    lines,
    log: (m) => lines.push(String(m)),
    error: (m) => lines.push(String(m)),
    text: () => lines.join("\n"),
  };
}

const HOST = "localhost";
const PORT = 5433;

describe("launchEmbeddedPglite", () => {
  it("pre-flight: fails fast when the port is already occupied, WITHOUT forking", async () => {
    const fork = vi.fn(() => fakeChild());
    const logger = fakeLogger();
    // preflight true => a foreign process (e.g. a real Postgres) already holds the port
    const preflightCheck = vi.fn(async () => true);
    const waitForTcp = vi.fn(async () => {});

    const result = await launchEmbeddedPglite({
      host: HOST,
      port: PORT,
      fork,
      waitForTcp,
      preflightCheck,
      logger,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("port-occupied");
    expect(result.port).toBe(PORT);
    // The whole point: do NOT fork onto an occupied port, and never claim readiness.
    expect(fork).not.toHaveBeenCalled();
    expect(waitForTcp).not.toHaveBeenCalled();
    expect(logger.text()).not.toMatch(/PGlite ready/i);
  });

  it("healthy start: port free, child alive when ready -> ok, emits 'PGlite ready'", async () => {
    const child = fakeChild();
    const fork = vi.fn(() => child);
    const logger = fakeLogger();
    const preflightCheck = vi.fn(async () => false);
    const waitForTcp = vi.fn(async () => {}); // resolves => ready

    const result = await launchEmbeddedPglite({
      host: HOST,
      port: PORT,
      fork,
      waitForTcp,
      preflightCheck,
      logger,
    });

    expect(result.ok).toBe(true);
    expect(result.child).toBe(child);
    expect(fork).toHaveBeenCalledTimes(1);
    expect(logger.text()).toMatch(/PGlite ready on port 5433/);
    expect(child.killed).toBe(false);
  });

  it("EADDRINUSE -> exit(0): child exits code 0 before ready -> FATAL (keys off exited-before-ready, not exit code)", async () => {
    const child = fakeChild();
    const fork = vi.fn(() => child);
    const logger = fakeLogger();
    const preflightCheck = vi.fn(async () => false);
    // waitForTcp never resolves during the test window; the child's exit must decide the outcome.
    const waitForTcp = vi.fn(() => new Promise(() => {}));

    const promise = launchEmbeddedPglite({
      host: HOST,
      port: PORT,
      fork,
      waitForTcp,
      preflightCheck,
      logger,
    });
    // Simulate the reproduced case: PGlite catches EADDRINUSE and shuts down cleanly
    // with code 0. Fire it after the async preflight has resolved and the launcher has
    // forked + attached its listeners (mirrors a real child dying during startup).
    await waitForListeners(child, "exit");
    child._emitExit(0);

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("child-exited");
    expect(result.exitInfo).toMatchObject({ code: 0 });
    // A non-zero-only check would have MISSED this — the assertion guards that.
    expect(logger.text()).not.toMatch(/PGlite ready/i);
  });

  it("non-zero exit: child exits code 1 before ready -> FATAL", async () => {
    const child = fakeChild();
    const fork = vi.fn(() => child);
    const logger = fakeLogger();
    const preflightCheck = vi.fn(async () => false);
    const waitForTcp = vi.fn(() => new Promise(() => {}));

    const promise = launchEmbeddedPglite({
      host: HOST,
      port: PORT,
      fork,
      waitForTcp,
      preflightCheck,
      logger,
    });
    await waitForListeners(child, "exit");
    child._emitExit(1);

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("child-exited");
    expect(result.exitInfo).toMatchObject({ code: 1 });
  });

  it("spawn error before ready -> FATAL", async () => {
    const child = fakeChild();
    const fork = vi.fn(() => child);
    const logger = fakeLogger();
    const preflightCheck = vi.fn(async () => false);
    const waitForTcp = vi.fn(() => new Promise(() => {}));

    const promise = launchEmbeddedPglite({
      host: HOST,
      port: PORT,
      fork,
      waitForTcp,
      preflightCheck,
      logger,
    });
    await waitForListeners(child, "error");
    child._emitError(new Error("spawn ENOENT"));

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("child-error");
  });

  it("ordering race: ready wins but child already exited -> still FATAL (double-check)", async () => {
    const child = fakeChild();
    const fork = vi.fn(() => child);
    const logger = fakeLogger();
    const preflightCheck = vi.fn(async () => false);
    // waitForTcp resolves immediately (as if a foreign listener answered), but the
    // child has ALSO exited — a dead child must not be accepted as success even when
    // the port probe succeeds. Set exitCode so the post-fork liveness check catches it.
    child.exitCode = 0;
    const waitForTcp = vi.fn(async () => {});

    const result = await launchEmbeddedPglite({
      host: HOST,
      port: PORT,
      fork,
      waitForTcp,
      preflightCheck,
      logger,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("child-exited");
    expect(logger.text()).not.toMatch(/PGlite ready/i);
  });

  it("readiness times out (waitForTcp rejects), child still alive -> FATAL and child killed", async () => {
    const child = fakeChild();
    const fork = vi.fn(() => child);
    const logger = fakeLogger();
    const preflightCheck = vi.fn(async () => false);
    const waitForTcp = vi.fn(async () => {
      throw new Error("PGlite failed to start within 15 seconds.");
    });

    const result = await launchEmbeddedPglite({
      host: HOST,
      port: PORT,
      fork,
      waitForTcp,
      preflightCheck,
      logger,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not-ready");
    // Don't leak the child if it's still running after a readiness timeout.
    expect(child.killed).toBe(true);
  });
});

describe("formatPortConflictMessage", () => {
  it("names the occupied port and suggests --pglite-port", () => {
    const msg = formatPortConflictMessage(5433);
    expect(msg).toMatch(/5433/);
    expect(msg).toMatch(/--pglite-port/);
    // Actionable: mentions the likely cause (another process / PostgreSQL on the port).
    expect(msg).toMatch(/occupied|in use|another/i);
  });
});

describe("isPrismaAuthFailure", () => {
  // Exact surface text captured from the installed Prisma 7.3.0 `migrate deploy`
  // (see task #379): `Error: P1000: Authentication failed against database server, the
  // provided database credentials for `postgres` are not valid.`
  const P1000 =
    'Error: P1000: Authentication failed against database server, the provided ' +
    "database credentials for `postgres` are not valid.\n\nPlease make sure to " +
    "provide valid database credentials for the database server at the configured address.";

  it("recognizes a real Prisma P1000 auth failure (by code token)", () => {
    expect(isPrismaAuthFailure(P1000)).toBe(true);
  });

  it("recognizes the auth phrase even without the P1000 token", () => {
    expect(
      isPrismaAuthFailure("Authentication failed against database server")
    ).toBe(true);
  });

  it("does NOT misfire on a non-auth migration error (P3009 / failed migration)", () => {
    const p3009 =
      "Error: P3009: migrate found failed migrations in the target database.\n" +
      "The `20260101_init` migration started but failed.";
    expect(isPrismaAuthFailure(p3009)).toBe(false);
  });

  it("does NOT misfire on a connectivity error (P1001 can't reach server)", () => {
    const p1001 =
      "Error: P1001: Can't reach database server at `localhost:5433`.\n" +
      "Please make sure your database server is running.";
    expect(isPrismaAuthFailure(p1001)).toBe(false);
  });

  it("tolerates empty/undefined output", () => {
    expect(isPrismaAuthFailure("")).toBe(false);
    expect(isPrismaAuthFailure(undefined)).toBe(false);
  });
});

describe("maskDbUrl", () => {
  it("masks credentials but keeps host:port", () => {
    const masked = maskDbUrl("postgresql://postgres:secretpw@localhost:5433/postgres?sslmode=disable");
    expect(masked).not.toMatch(/secretpw/);
    expect(masked).toMatch(/localhost:5433/);
  });

  it("handles a URL without credentials", () => {
    expect(maskDbUrl("postgresql://localhost:5433/postgres")).toMatch(/localhost:5433/);
  });

  it("returns a placeholder for empty input", () => {
    expect(maskDbUrl("")).toBeTruthy();
  });
});

describe("formatMigrationAuthDiagnostic", () => {
  it("embedded-PGlite path: blames port occupancy, suggests --pglite-port, masks creds", () => {
    const msg = formatMigrationAuthDiagnostic({
      effectiveUrl: "postgresql://postgres:postgres@localhost:5433/postgres?sslmode=disable",
      startedEmbedded: true,
      pglitePort: 5433,
    });
    expect(msg).toMatch(/localhost:5433/);
    expect(msg).toMatch(/--pglite-port/);
    expect(msg).toMatch(/occupied|another PostgreSQL|in use/i);
    // Should NOT tell the embedded-path user to unset DATABASE_URL (they didn't set one).
    expect(msg).not.toMatch(/unset DATABASE_URL/);
  });

  it("external DATABASE_URL path: names host:port, tells user to unset DATABASE_URL, masks creds", () => {
    const msg = formatMigrationAuthDiagnostic({
      effectiveUrl: "postgresql://admin:hunter2@db.example.com:5432/prod",
      startedEmbedded: false,
      pglitePort: 5433,
    });
    expect(msg).not.toMatch(/hunter2/);
    expect(msg).toMatch(/db\.example\.com:5432/);
    expect(msg).toMatch(/unset DATABASE_URL/);
    expect(msg).toMatch(/DATABASE_URL/);
  });
});

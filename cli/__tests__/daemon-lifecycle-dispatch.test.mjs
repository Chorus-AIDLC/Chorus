// cli/__tests__/daemon-lifecycle-dispatch.test.mjs
// Covers runDaemon's lifecycle-action dispatch (stop/status/restart/logs) and
// the -d detach ordering (foreground preflight BEFORE detach; double-start guard).
import { describe, it, expect, vi } from "vitest";
import { runDaemon, DETACHED_ENV } from "../daemon.mjs";

/** A fake lifecycle injected into runDaemon. */
function fakeLifecycle(over = {}) {
  return {
    isRunning: vi.fn(() => ({ running: false, pid: null, stale: false })),
    startBackground: vi.fn(() => ({ started: true, pid: 321, logFile: "/l", pidFile: "/p" })),
    stopDaemon: vi.fn(() => ({ stopped: true, pid: 9, reason: "stopped", message: "stopped daemon (pid 9)" })),
    readLog: vi.fn(() => ({ ok: true, content: "log-body" })),
    ...over,
  };
}

describe("runDaemon — lifecycle action dispatch", () => {
  it("status reports running pid and never builds the daemon", async () => {
    const logs = [];
    const build = vi.fn();
    const lifecycle = fakeLifecycle({ isRunning: () => ({ running: true, pid: 77, stale: false }) });
    const code = await runDaemon(
      { action: "status" },
      { lifecycle, build, log: (m) => logs.push(m), errLog: () => {}, env: {} }
    );
    expect(code).toBe(0);
    expect(logs.join("")).toMatch(/running \(pid 77\)/);
    expect(build).not.toHaveBeenCalled();
  });

  it("status reports 'not running' clearly when absent", async () => {
    const logs = [];
    const code = await runDaemon(
      { action: "status" },
      { lifecycle: fakeLifecycle(), build: vi.fn(), log: (m) => logs.push(m), errLog: () => {}, env: {} }
    );
    expect(code).toBe(0);
    expect(logs.join("")).toMatch(/not running/i);
  });

  it("logs prints the log body; errors clearly when no log", async () => {
    const out = [];
    const ok = await runDaemon(
      { action: "logs" },
      { lifecycle: fakeLifecycle(), log: (m) => out.push(m), errLog: (m) => out.push("E:" + m), env: {} }
    );
    expect(ok).toBe(0);
    expect(out.join("")).toContain("log-body");

    const errs = [];
    const bad = await runDaemon(
      { action: "logs" },
      { lifecycle: fakeLifecycle({ readLog: () => ({ ok: false, message: "no log file at /l" }) }), log: () => {}, errLog: (m) => errs.push(m), env: {} }
    );
    expect(bad).toBe(1);
    expect(errs.join("")).toMatch(/no log file/);
  });

  it("stop returns 0 when it stopped, 1 (with clear message) when nothing ran", async () => {
    const okCode = await runDaemon({ action: "stop" }, { lifecycle: fakeLifecycle(), log: () => {}, errLog: () => {}, env: {} });
    expect(okCode).toBe(0);

    const errs = [];
    const badCode = await runDaemon(
      { action: "stop" },
      { lifecycle: fakeLifecycle({ stopDaemon: () => ({ stopped: false, pid: null, reason: "not-running", message: "no daemon is running" }) }), log: () => {}, errLog: (m) => errs.push(m), env: {} }
    );
    expect(badCode).toBe(1);
    expect(errs.join("")).toMatch(/no daemon/);
  });

  it("stop exit-code contract: 0 for stale-cleared and forced, 1 for error", async () => {
    // stale-cleared leaves "no daemon, no pidfile" — a successful self-heal
    // must not fail `chorus daemon stop && …` chains.
    const staleCode = await runDaemon(
      { action: "stop" },
      { lifecycle: fakeLifecycle({ stopDaemon: () => ({ stopped: false, pid: 9, reason: "stale-cleared", message: "no live daemon (cleared stale pidfile for pid 9)" }) }), log: () => {}, errLog: () => {}, env: {} }
    );
    expect(staleCode).toBe(0);

    const forcedCode = await runDaemon(
      { action: "stop" },
      { lifecycle: fakeLifecycle({ stopDaemon: () => ({ stopped: true, pid: 9, reason: "forced", message: "forced cleanup" }) }), log: () => {}, errLog: () => {}, env: {} }
    );
    expect(forcedCode).toBe(0);

    const errCode = await runDaemon(
      { action: "stop" },
      { lifecycle: fakeLifecycle({ stopDaemon: () => ({ stopped: false, pid: 9, reason: "error", message: "failed to signal pid 9" }) }), log: () => {}, errLog: () => {}, env: {} }
    );
    expect(errCode).toBe(1);
  });

  it("stop threads --force into stopDaemon; plain stop does not", async () => {
    const lifecycle = fakeLifecycle();
    await runDaemon({ action: "stop", force: true }, { lifecycle, log: () => {}, errLog: () => {}, env: {} });
    expect(lifecycle.stopDaemon).toHaveBeenCalledWith({ force: true });

    const lifecycle2 = fakeLifecycle();
    await runDaemon({ action: "stop" }, { lifecycle: lifecycle2, log: () => {}, errLog: () => {}, env: {} });
    expect(lifecycle2.stopDaemon).toHaveBeenCalledWith({ force: false });
  });

  it("restart stops then starts a detached instance (skip-preflight, no prompt)", async () => {
    const lifecycle = fakeLifecycle();
    const ask = vi.fn();
    const code = await runDaemon(
      { action: "restart" },
      { lifecycle, prompt: ask, log: () => {}, errLog: () => {}, env: {} }
    );
    expect(code).toBe(0);
    expect(lifecycle.stopDaemon).toHaveBeenCalledOnce();
    expect(lifecycle.startBackground).toHaveBeenCalledOnce();
    expect(ask).not.toHaveBeenCalled(); // restart is non-interactive
    // The detached child carries the marker so it skips preflight.
    expect(lifecycle.startBackground.mock.calls[0][0].env[DETACHED_ENV]).toBe("1");
  });

  it("restart keeps non-forced stop semantics even with --force present", async () => {
    const lifecycle = fakeLifecycle();
    await runDaemon({ action: "restart", force: true }, { lifecycle, log: () => {}, errLog: () => {}, env: {} });
    // restart must not silently discard a pidfile it couldn't verify.
    expect(lifecycle.stopDaemon).toHaveBeenCalledWith();
  });
});

describe("runDaemon — -d detach ordering", () => {
  it("runs preflight (credential validation) in the foreground BEFORE detaching", async () => {
    const calls = [];
    const lifecycle = fakeLifecycle({
      startBackground: vi.fn(() => { calls.push("detach"); return { started: true, pid: 55, logFile: "/l", pidFile: "/p" }; }),
    });
    const code = await runDaemon(
      { detach: true },
      {
        isTTY: true,
        resolve: () => ({ url: "u", apiKey: "cho_x", source: "env" }),
        validate: async () => { calls.push("preflight"); return { uuid: "a", name: "Bot" }; },
        lifecycle,
        log: () => {},
        errLog: () => {},
        env: {},
      }
    );
    expect(code).toBe(0);
    // Preflight (credential validation) ran BEFORE the detach spawn.
    expect(calls).toEqual(["preflight", "detach"]);
  });

  it("a failed preflight (credential validation) aborts WITHOUT detaching", async () => {
    const lifecycle = fakeLifecycle();
    const errs = [];
    const code = await runDaemon(
      { detach: true },
      {
        isTTY: true,
        resolve: () => ({ url: "u", apiKey: "cho_x", source: "env" }),
        validate: async () => { throw new Error("bad key"); },
        lifecycle,
        log: () => {},
        errLog: (m) => errs.push(m),
        env: {},
      }
    );
    expect(code).toBe(1);
    expect(lifecycle.startBackground).not.toHaveBeenCalled();
    expect(errs.join("")).toMatch(/validation failed/);
  });

  it("refuses to detach when a daemon is already running", async () => {
    const lifecycle = fakeLifecycle({ isRunning: () => ({ running: true, pid: 88, stale: false }) });
    const errs = [];
    const code = await runDaemon(
      { detach: true },
      { isTTY: true, lifecycle, prompt: vi.fn(), log: () => {}, errLog: (m) => errs.push(m), env: {} }
    );
    expect(code).toBe(1);
    expect(lifecycle.startBackground).not.toHaveBeenCalled();
    expect(errs.join("")).toMatch(/already running \(pid 88\)/);
  });

  it("a detached child (marker set) skips detach and runs the daemon normally", async () => {
    const build = vi.fn(() => ({ async start() {}, async stop() {} }));
    const lifecycle = fakeLifecycle();
    const code = await runDaemon(
      { detach: true },
      {
        isTTY: false,
        env: { [DETACHED_ENV]: "1" },
        resolve: () => ({ url: "u", apiKey: "cho_x", source: "env" }),
        validate: async () => ({ uuid: "a", name: "Bot" }),
        build,
        lifecycle,
        waitForever: async () => {},
        log: () => {},
        errLog: () => {},
      }
    );
    expect(code).toBe(0);
    expect(build).toHaveBeenCalledOnce(); // ran the daemon, did not re-detach
    expect(lifecycle.startBackground).not.toHaveBeenCalled();
  });
});

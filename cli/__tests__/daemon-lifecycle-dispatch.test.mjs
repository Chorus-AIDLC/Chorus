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

/**
 * A fake supervisor seam. Default: no supervisor installed (kind:none), so the
 * control verbs fall through to the pidfile path — the pre-existing behavior.
 * On a host that actually runs the chorus systemd unit the real detectSupervisor
 * would fire, so every dispatch test injects this stub for isolation.
 */
function fakeService(over = {}) {
  return {
    detectSupervisor: vi.fn(() => ({ kind: "none" })),
    installService: vi.fn(() => ({ platform: "linux", installed: true, unitPath: "/u", unitText: "", steps: ["wrote /u"] })),
    uninstallService: vi.fn(() => ({ platform: "linux", removed: true, unitPath: "/u", steps: ["removed /u"] })),
    systemctlUser: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
    journalctlUser: vi.fn(() => ({ status: 0, stdout: "journal-body", stderr: "" })),
    resolveServicePaths: vi.fn(() => ({ nodePath: "/node", scriptPath: "/x/chorus.mjs", path: "/bin" })),
    // The install pre-config phase (credential preflight + cwd wizard). Default:
    // both succeed offline so the install dispatch tests never touch real
    // credentials / network / TTY. Individual tests override to exercise abort.
    installConfig: {
      resolveInstallCredentials: vi.fn(async () => ({ ok: true, creds: { url: "u", apiKey: "cho_k" }, identity: { uuid: "a", name: "Bot" } })),
      resolveInstallCwds: vi.fn(async () => ({ cwds: ["/a"] })),
    },
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
      { lifecycle, service: fakeService(), build, log: (m) => logs.push(m), errLog: () => {}, env: {} }
    );
    expect(code).toBe(0);
    expect(logs.join("")).toMatch(/running \(pid 77\)/);
    expect(build).not.toHaveBeenCalled();
  });

  it("status reports 'not running' clearly when absent", async () => {
    const logs = [];
    const code = await runDaemon(
      { action: "status" },
      { lifecycle: fakeLifecycle(), service: fakeService(), build: vi.fn(), log: (m) => logs.push(m), errLog: () => {}, env: {} }
    );
    expect(code).toBe(0);
    expect(logs.join("")).toMatch(/not running/i);
  });

  it("logs prints the log body; errors clearly when no log", async () => {
    const out = [];
    const ok = await runDaemon(
      { action: "logs" },
      { lifecycle: fakeLifecycle(), service: fakeService(), log: (m) => out.push(m), errLog: (m) => out.push("E:" + m), env: {} }
    );
    expect(ok).toBe(0);
    expect(out.join("")).toContain("log-body");

    const errs = [];
    const bad = await runDaemon(
      { action: "logs" },
      { lifecycle: fakeLifecycle({ readLog: () => ({ ok: false, message: "no log file at /l" }) }), service: fakeService(), log: () => {}, errLog: (m) => errs.push(m), env: {} }
    );
    expect(bad).toBe(1);
    expect(errs.join("")).toMatch(/no log file/);
  });

  it("stop returns 0 when it stopped, 1 (with clear message) when nothing ran", async () => {
    const okCode = await runDaemon({ action: "stop" }, { lifecycle: fakeLifecycle(), service: fakeService(), log: () => {}, errLog: () => {}, env: {} });
    expect(okCode).toBe(0);

    const errs = [];
    const badCode = await runDaemon(
      { action: "stop" },
      { lifecycle: fakeLifecycle({ stopDaemon: () => ({ stopped: false, pid: null, reason: "not-running", message: "no daemon is running" }) }), service: fakeService(), log: () => {}, errLog: (m) => errs.push(m), env: {} }
    );
    expect(badCode).toBe(1);
    expect(errs.join("")).toMatch(/no daemon/);
  });

  it("stop exit-code contract: 0 for stale-cleared and forced, 1 for error", async () => {
    // stale-cleared leaves "no daemon, no pidfile" — a successful self-heal
    // must not fail `chorus daemon stop && …` chains.
    const staleCode = await runDaemon(
      { action: "stop" },
      { lifecycle: fakeLifecycle({ stopDaemon: () => ({ stopped: false, pid: 9, reason: "stale-cleared", message: "no live daemon (cleared stale pidfile for pid 9)" }) }), service: fakeService(), log: () => {}, errLog: () => {}, env: {} }
    );
    expect(staleCode).toBe(0);

    const forcedCode = await runDaemon(
      { action: "stop" },
      { lifecycle: fakeLifecycle({ stopDaemon: () => ({ stopped: true, pid: 9, reason: "forced", message: "forced cleanup" }) }), service: fakeService(), log: () => {}, errLog: () => {}, env: {} }
    );
    expect(forcedCode).toBe(0);

    const errCode = await runDaemon(
      { action: "stop" },
      { lifecycle: fakeLifecycle({ stopDaemon: () => ({ stopped: false, pid: 9, reason: "error", message: "failed to signal pid 9" }) }), service: fakeService(), log: () => {}, errLog: () => {}, env: {} }
    );
    expect(errCode).toBe(1);
  });

  it("stop threads --force into stopDaemon; plain stop does not", async () => {
    const lifecycle = fakeLifecycle();
    await runDaemon({ action: "stop", force: true }, { lifecycle, service: fakeService(), log: () => {}, errLog: () => {}, env: {} });
    expect(lifecycle.stopDaemon).toHaveBeenCalledWith({ force: true });

    const lifecycle2 = fakeLifecycle();
    await runDaemon({ action: "stop" }, { lifecycle: lifecycle2, service: fakeService(), log: () => {}, errLog: () => {}, env: {} });
    expect(lifecycle2.stopDaemon).toHaveBeenCalledWith({ force: false });
  });

  it("restart stops then starts a detached instance (skip-preflight, no prompt)", async () => {
    const lifecycle = fakeLifecycle();
    const ask = vi.fn();
    const code = await runDaemon(
      { action: "restart" },
      { lifecycle, service: fakeService(), prompt: ask, log: () => {}, errLog: () => {}, env: {} }
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
    await runDaemon({ action: "restart", force: true }, { lifecycle, service: fakeService(), log: () => {}, errLog: () => {}, env: {} });
    // restart must not silently discard a pidfile it couldn't verify.
    expect(lifecycle.stopDaemon).toHaveBeenCalledWith();
  });
});

describe("runDaemon — supervisor (systemd) delegation", () => {
  // When a systemd unit is installed+active, the control verbs must route to
  // systemctl/journalctl instead of the pidfile — so a supervised daemon is
  // never misreported as "not running" (the boot-storm confusion).
  const installedActive = () => fakeService({
    detectSupervisor: vi.fn(() => ({ kind: "systemd", installed: true, active: true, unitPath: "/u" })),
  });

  it("status delegates to systemctl and never touches the pidfile", async () => {
    const logs = [];
    const service = installedActive();
    service.systemctlUser = vi.fn(() => ({ status: 0, stdout: "● chorus-daemon.service active", stderr: "" }));
    const lifecycle = fakeLifecycle();
    const code = await runDaemon(
      { action: "status" },
      { lifecycle, service, log: (m) => logs.push(m), errLog: () => {}, env: {} }
    );
    expect(code).toBe(0);
    expect(logs.join("")).toMatch(/managed by systemd/);
    expect(service.systemctlUser).toHaveBeenCalledWith(["status", "--no-pager", "chorus-daemon.service"]);
    expect(lifecycle.isRunning).not.toHaveBeenCalled();
  });

  it("status returns 1 when the unit is installed but NOT active", async () => {
    const service = fakeService({
      detectSupervisor: () => ({ kind: "systemd", installed: true, active: false, unitPath: "/u" }),
    });
    const logs = [];
    const code = await runDaemon(
      { action: "status" },
      { lifecycle: fakeLifecycle(), service, log: (m) => logs.push(m), errLog: () => {}, env: {} }
    );
    expect(code).toBe(1);
    expect(logs.join("")).toMatch(/NOT active/);
  });

  it("stop delegates to systemctl stop and does not signal the pidfile", async () => {
    const service = installedActive();
    const lifecycle = fakeLifecycle();
    const logs = [];
    const code = await runDaemon(
      { action: "stop" },
      { lifecycle, service, log: (m) => logs.push(m), errLog: () => {}, env: {} }
    );
    expect(code).toBe(0);
    expect(service.systemctlUser).toHaveBeenCalledWith(["stop", "chorus-daemon.service"]);
    expect(lifecycle.stopDaemon).not.toHaveBeenCalled();
    expect(logs.join("")).toMatch(/stopped the daemon service/);
  });

  it("restart delegates to systemctl restart and does not re-detach", async () => {
    const service = installedActive();
    const lifecycle = fakeLifecycle();
    const code = await runDaemon(
      { action: "restart" },
      { lifecycle, service, log: () => {}, errLog: () => {}, env: {} }
    );
    expect(code).toBe(0);
    expect(service.systemctlUser).toHaveBeenCalledWith(["restart", "chorus-daemon.service"]);
    expect(lifecycle.startBackground).not.toHaveBeenCalled();
  });

  it("logs delegates to journalctl", async () => {
    const service = installedActive();
    service.journalctlUser = vi.fn(() => ({ status: 0, stdout: "journal-line", stderr: "" }));
    const out = [];
    const code = await runDaemon(
      { action: "logs" },
      { lifecycle: fakeLifecycle(), service, log: (m) => out.push(m), errLog: () => {}, env: {} }
    );
    expect(code).toBe(0);
    expect(service.journalctlUser).toHaveBeenCalledWith(["-u", "chorus-daemon.service", "--no-pager", "-n", "200"]);
    expect(out.join("")).toContain("journal-line");
  });

  it("a stop failure under systemd surfaces the error and returns 1", async () => {
    const service = installedActive();
    service.systemctlUser = vi.fn(() => ({ status: 1, stdout: "", stderr: "Failed to stop" }));
    const errs = [];
    const code = await runDaemon(
      { action: "stop" },
      { lifecycle: fakeLifecycle(), service, log: () => {}, errLog: (m) => errs.push(m), env: {} }
    );
    expect(code).toBe(1);
    expect(errs.join("")).toMatch(/failed to stop the service/i);
  });
});

describe("runDaemon — install / uninstall", () => {
  it("install runs the credential + cwd config phase, then passes --agent/--chorus-only into the spec and reports success", async () => {
    const service = fakeService();
    const logs = [];
    const code = await runDaemon(
      { action: "install", cwd: ["/a", "/b"], agent: "claude-code", chorusOnly: true },
      { lifecycle: fakeLifecycle(), service, log: (m) => logs.push(m), errLog: () => {}, env: {} }
    );
    expect(code).toBe(0);
    // Config phase ran before the unit was written.
    expect(service.installConfig.resolveInstallCredentials).toHaveBeenCalledOnce();
    expect(service.installConfig.resolveInstallCwds).toHaveBeenCalledOnce();
    const spec = service.installService.mock.calls[0][0];
    expect(spec.agent).toBe("claude-code");
    expect(spec.chorusOnly).toBe(true);
    expect(logs.join("")).toMatch(/installed and started/);
  });

  it("install ABORTS (exit 1, no unit written) when the credential preflight fails", async () => {
    const service = fakeService({
      installConfig: {
        resolveInstallCredentials: vi.fn(async () => ({ ok: false })),
        resolveInstallCwds: vi.fn(async () => ({ cwds: ["/a"] })),
      },
    });
    const errs = [];
    const code = await runDaemon(
      { action: "install" },
      { lifecycle: fakeLifecycle(), service, log: () => {}, errLog: (m) => errs.push(m), env: {} }
    );
    expect(code).toBe(1);
    // installService must NOT be called on the abort path.
    expect(service.installService).not.toHaveBeenCalled();
    // cwd config must not run once credentials aborted.
    expect(service.installConfig.resolveInstallCwds).not.toHaveBeenCalled();
    expect(errs.join("")).toMatch(/aborted/i);
  });

  it("install threads skip=true when --yes is passed", async () => {
    const service = fakeService();
    await runDaemon(
      { action: "install", yes: true },
      { lifecycle: fakeLifecycle(), service, isTTY: true, log: () => {}, errLog: () => {}, env: {} }
    );
    const credOpts = service.installConfig.resolveInstallCredentials.mock.calls[0][2];
    expect(credOpts.skip).toBe(true);
  });

  it("install threads skip=true on a non-TTY even without --yes", async () => {
    const service = fakeService();
    await runDaemon(
      { action: "install" },
      { lifecycle: fakeLifecycle(), service, isTTY: false, log: () => {}, errLog: () => {}, env: {} }
    );
    const credOpts = service.installConfig.resolveInstallCredentials.mock.calls[0][2];
    expect(credOpts.skip).toBe(true);
  });

  it("install surfaces a Linux failure as exit 1", async () => {
    const service = fakeService({
      installService: () => ({ platform: "linux", installed: false, unitPath: "/u", unitText: "", steps: ["wrote /u"], error: "daemon-reload failed" }),
    });
    const errs = [];
    const code = await runDaemon(
      { action: "install" },
      { lifecycle: fakeLifecycle(), service, log: () => {}, errLog: (m) => errs.push(m), env: {} }
    );
    expect(code).toBe(1);
    expect(errs.join("")).toMatch(/install failed: daemon-reload failed/);
  });

  it("install on macOS prints the template + steps and exits 0 without failing", async () => {
    const service = fakeService({
      installService: () => ({ platform: "darwin", installed: false, unitPath: "/p.plist", unitText: "<plist/>", steps: ["Save the plist below to /p.plist"] }),
    });
    const logs = [];
    const code = await runDaemon(
      { action: "install" },
      { lifecycle: fakeLifecycle(), service, log: (m) => logs.push(m), errLog: () => {}, env: {} }
    );
    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/Linux-only/);
    expect(logs.join("\n")).toContain("<plist/>");
  });

  it("uninstall reports removal on Linux; 'nothing to remove' when absent", async () => {
    const removed = fakeService();
    const okLogs = [];
    await runDaemon({ action: "uninstall" }, { lifecycle: fakeLifecycle(), service: removed, log: (m) => okLogs.push(m), errLog: () => {}, env: {} });
    expect(okLogs.join("")).toMatch(/removed the daemon service/);

    const none = fakeService({ uninstallService: () => ({ platform: "linux", removed: false, unitPath: "/u", steps: [] }) });
    const noneLogs = [];
    await runDaemon({ action: "uninstall" }, { lifecycle: fakeLifecycle(), service: none, log: (m) => noneLogs.push(m), errLog: () => {}, env: {} });
    expect(noneLogs.join("")).toMatch(/nothing to remove/);
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

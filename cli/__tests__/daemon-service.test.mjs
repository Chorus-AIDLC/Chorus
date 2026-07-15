// cli/__tests__/daemon-service.test.mjs
// Unit tests for the supervisor-service module: pure unit/plist rendering, the
// systemd detection probe, and the install/uninstall IO orchestration (all IO
// injected — no real systemctl / disk).
import { describe, it, expect, vi } from "vitest";
import {
  SERVICE_NAME,
  systemdUnitPath,
  launchdPlistPath,
  buildServiceArgs,
  renderSystemdUnit,
  renderLaunchdPlist,
  detectSupervisor,
  installService,
  uninstallService,
  systemctlUser,
  resolveServicePaths,
} from "../daemon-service.mjs";

const BASE = {
  nodePath: "/usr/bin/node",
  scriptPath: "/opt/chorus/chorus.mjs",
  workingDir: "/home/u/dev/proj",
  home: "/home/u",
  path: "/home/u/.local/bin:/usr/bin:/bin",
};

describe("buildServiceArgs", () => {
  it("emits the normal daemon argv WITHOUT -d and WITHOUT --cwd", () => {
    // cwds now live in ~/.chorus/daemon.json `cwds` (single source of truth,
    // persisted at install time), so the unit must NOT embed --cwd or the two
    // sources drift (elaboration Q5-A).
    const args = buildServiceArgs({ scriptPath: "/x/chorus.mjs", cwds: ["/a", "/b"] });
    expect(args).toEqual(["/x/chorus.mjs", "daemon"]);
    expect(args).not.toContain("-d");
    expect(args).not.toContain("--cwd");
  });

  it("includes --agent and --chorus-only when set; never emits --cwd", () => {
    const args = buildServiceArgs({ scriptPath: "/x/chorus.mjs", cwds: ["/a", "", undefined], agent: "codex", chorusOnly: true });
    expect(args).toEqual(["/x/chorus.mjs", "daemon", "--agent", "codex", "--chorus-only"]);
    expect(args).not.toContain("--cwd");
  });
});

describe("renderSystemdUnit (pure)", () => {
  const unit = renderSystemdUnit({ ...BASE, cwds: ["/a", "/b"] });

  it("uses Type=simple, NO -d, and NO --cwd in ExecStart", () => {
    expect(unit).toMatch(/^Type=simple$/m);
    // cwds are read from daemon.json, not the unit — ExecStart is just node + script + daemon.
    expect(unit).toMatch(/ExecStart=\/usr\/bin\/node \/opt\/chorus\/chorus\.mjs daemon$/m);
    // The self-daemonize flag must never appear ON THE ExecStart LINE — that was
    // the boot-loop cause. (Comment lines legitimately mention "-d".)
    const execLine = unit.split("\n").find((l) => l.startsWith("ExecStart="));
    expect(execLine).not.toMatch(/(\s)-d(\s|$)/);
    expect(execLine).not.toMatch(/--detach/);
    expect(execLine).not.toMatch(/--cwd/);
    expect(unit).not.toMatch(/Type=forking/);
  });

  it("has NO ExecStop (Type=simple stop = SIGTERM to the graceful handler)", () => {
    expect(unit).not.toMatch(/ExecStop=/);
  });

  it("carries --agent / --chorus-only on ExecStart but never --cwd", () => {
    const u = renderSystemdUnit({ ...BASE, cwds: ["/a"], agent: "codex", chorusOnly: true });
    const execLine = u.split("\n").find((l) => l.startsWith("ExecStart="));
    expect(execLine).toContain("--agent codex");
    expect(execLine).toContain("--chorus-only");
    expect(execLine).not.toMatch(/--cwd/);
  });

  it("never bakes credentials into the unit (no CHORUS_API_KEY / CHORUS_URL env line)", () => {
    // Credentials live only in the 0600 ~/.chorus/daemon.json — a systemd
    // Environment= line carrying the secret would be weaker isolation and is a
    // regression the review flagged.
    expect(unit).not.toMatch(/CHORUS_API_KEY/);
    expect(unit).not.toMatch(/CHORUS_URL/);
  });

  it("quotes a node/script path that itself contains a space", () => {
    const u = renderSystemdUnit({ ...BASE, nodePath: "/opt/My Tools/node", cwds: ["/a"] });
    const execLine = u.split("\n").find((l) => l.startsWith("ExecStart="));
    expect(execLine).toContain('ExecStart="/opt/My Tools/node"');
  });

  it("carries Restart=on-failure, RestartSec, TimeoutStopSec, PATH, HOME, WantedBy", () => {
    expect(unit).toMatch(/^Restart=on-failure$/m);
    expect(unit).toMatch(/^RestartSec=10$/m);
    expect(unit).toMatch(/^TimeoutStopSec=30$/m);
    expect(unit).toMatch(/^Environment=PATH=\/home\/u\/\.local\/bin:\/usr\/bin:\/bin$/m);
    expect(unit).toMatch(/^Environment=HOME=\/home\/u$/m);
    expect(unit).toMatch(/^WantedBy=default\.target$/m);
    expect(unit).toMatch(new RegExp(`^SyslogIdentifier=${SERVICE_NAME}$`, "m"));
  });

  it("respects custom restartSec / timeoutStopSec", () => {
    const u = renderSystemdUnit({ ...BASE, restartSec: 5, timeoutStopSec: 45 });
    expect(u).toMatch(/^RestartSec=5$/m);
    expect(u).toMatch(/^TimeoutStopSec=45$/m);
  });
});

describe("renderLaunchdPlist (pure)", () => {
  const plist = renderLaunchdPlist({ ...BASE, cwds: ["/a"], logPath: "/home/u/.chorus/daemon.log" });

  it("emits RunAtLoad + KeepAlive and the daemon argv without -d or --cwd", () => {
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<string>/opt/chorus/chorus.mjs</string>");
    expect(plist).toContain("<string>daemon</string>");
    // cwds live in daemon.json, never in the plist ProgramArguments.
    expect(plist).not.toContain("<string>--cwd</string>");
    expect(plist).not.toContain("<string>-d</string>");
    expect(plist).toContain("com.chorus.daemon");
  });

  it("never bakes credentials into the plist", () => {
    expect(plist).not.toContain("CHORUS_API_KEY");
    expect(plist).not.toContain("CHORUS_URL");
  });

  it("xml-escapes special characters in paths", () => {
    const p = renderLaunchdPlist({ ...BASE, workingDir: "/a & b/<x>", cwds: [], logPath: "/l" });
    expect(p).toContain("/a &amp; b/&lt;x&gt;");
  });
});

describe("detectSupervisor", () => {
  function io(over = {}) {
    return {
      platform: "linux",
      home: "/home/u",
      existsSync: vi.fn(() => true),
      spawnSync: vi.fn(() => ({ status: 0, stdout: "active\n", stderr: "" })),
      ...over,
    };
  }

  it("returns kind:none off Linux", () => {
    expect(detectSupervisor(io({ platform: "darwin" }))).toEqual({ kind: "none" });
    expect(detectSupervisor(io({ platform: "win32" }))).toEqual({ kind: "none" });
  });

  it("installed + active when the unit exists and is-active says active", () => {
    const r = detectSupervisor(io());
    expect(r.kind).toBe("systemd");
    expect(r.installed).toBe(true);
    expect(r.active).toBe(true);
    expect(r.unitPath).toBe(systemdUnitPath({ home: "/home/u" }));
  });

  it("installed + inactive when the unit exists but is-active is not 'active'", () => {
    const r = detectSupervisor(io({ spawnSync: () => ({ status: 3, stdout: "inactive\n", stderr: "" }) }));
    expect(r).toMatchObject({ kind: "systemd", installed: true, active: false });
  });

  it("kind:none when neither the unit file nor an active service exists", () => {
    const r = detectSupervisor(io({ existsSync: () => false, spawnSync: () => ({ status: 3, stdout: "inactive\n", stderr: "" }) }));
    expect(r).toEqual({ kind: "none" });
  });

  it("still reports systemd when inactive but the unit file is present", () => {
    const r = detectSupervisor(io({ existsSync: () => true, spawnSync: () => ({ status: 3, stdout: "unknown\n", stderr: "" }) }));
    expect(r).toMatchObject({ kind: "systemd", installed: true, active: false });
  });
});

describe("installService", () => {
  function linuxIO(over = {}) {
    const calls = [];
    return {
      io: {
        platform: "linux",
        home: "/home/u",
        mkdirSync: vi.fn(),
        writeFileSync: vi.fn(),
        existsSync: vi.fn(() => true),
        unlinkSync: vi.fn(),
        spawnSync: vi.fn((cmd, args) => {
          calls.push([cmd, ...args]);
          return { status: 0, stdout: "", stderr: "" };
        }),
        ...over,
      },
      calls,
    };
  }

  it("writes the unit, daemon-reloads, enable --now, then restart on Linux", () => {
    const { io, calls } = linuxIO();
    const r = installService({ ...BASE }, io);
    expect(r).toMatchObject({ platform: "linux", installed: true });
    expect(io.writeFileSync).toHaveBeenCalledOnce();
    const [path, text] = io.writeFileSync.mock.calls[0];
    expect(path).toBe(systemdUnitPath({ home: "/home/u" }));
    expect(text).toMatch(/Type=simple/);
    // ordered systemctl calls — restart follows enable so a re-install with new
    // flags actually applies to an already-running daemon (not just a no-op start).
    expect(calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", `${SERVICE_NAME}.service`],
      ["systemctl", "--user", "restart", `${SERVICE_NAME}.service`],
    ]);
  });

  it("a failed restart does not fail an otherwise-good install", () => {
    const { io } = linuxIO({
      spawnSync: vi.fn((_cmd, args) => (args.includes("restart") ? { status: 1, stdout: "", stderr: "transient" } : { status: 0, stdout: "", stderr: "" })),
    });
    const r = installService({ ...BASE }, io);
    expect(r.installed).toBe(true);
    // restart step is best-effort — omitted from steps on failure, install still succeeds
    expect(r.steps.some((s) => s.includes("restart"))).toBe(false);
  });

  it("returns installed:false + error when daemon-reload fails", () => {
    const { io } = linuxIO({
      spawnSync: vi.fn((_cmd, args) => (args.includes("daemon-reload") ? { status: 1, stdout: "", stderr: "boom" } : { status: 0, stdout: "", stderr: "" })),
    });
    const r = installService({ ...BASE }, io);
    expect(r.installed).toBe(false);
    expect(r.error).toMatch(/daemon-reload failed: boom/);
  });

  it("returns installed:false + error when enable --now fails", () => {
    const { io } = linuxIO({
      spawnSync: vi.fn((_cmd, args) => (args.includes("enable") ? { status: 1, stdout: "", stderr: "nope" } : { status: 0, stdout: "", stderr: "" })),
    });
    const r = installService({ ...BASE }, io);
    expect(r.installed).toBe(false);
    expect(r.error).toMatch(/enable --now failed: nope/);
  });

  it("darwin: does not write, returns a plist template + manual steps", () => {
    const io = { platform: "darwin", home: "/home/u", writeFileSync: vi.fn(), mkdirSync: vi.fn(), spawnSync: vi.fn() };
    const r = installService({ ...BASE }, io);
    expect(r).toMatchObject({ platform: "darwin", installed: false });
    expect(io.writeFileSync).not.toHaveBeenCalled();
    expect(r.unitText).toContain("<plist");
    expect(r.unitPath).toBe(launchdPlistPath({ home: "/home/u" }));
    expect(r.steps.join(" ")).toMatch(/launchctl load/);
  });

  it("other platform: returns the foreground command with no -d and no write", () => {
    const io = { platform: "win32", home: "C:/Users/u", writeFileSync: vi.fn(), spawnSync: vi.fn() };
    const r = installService({ ...BASE, cwds: ["/a"] }, io);
    expect(r.platform).toBe("other");
    expect(r.installed).toBe(false);
    expect(io.writeFileSync).not.toHaveBeenCalled();
    expect(r.unitText).not.toMatch(/ -d(\s|$)/);
    expect(r.unitText).not.toMatch(/--cwd/);
    expect(r.unitText).toContain("chorus.mjs daemon");
  });
});

describe("uninstallService", () => {
  it("disables, removes the unit, and reloads on Linux", () => {
    const calls = [];
    const io = {
      platform: "linux",
      home: "/home/u",
      existsSync: vi.fn(() => true),
      unlinkSync: vi.fn(),
      spawnSync: vi.fn((cmd, args) => {
        calls.push(args.join(" "));
        return { status: 0, stdout: "", stderr: "" };
      }),
    };
    const r = uninstallService(io);
    expect(r).toMatchObject({ platform: "linux", removed: true });
    expect(io.unlinkSync).toHaveBeenCalledWith(systemdUnitPath({ home: "/home/u" }));
    expect(calls).toContain(`--user disable --now ${SERVICE_NAME}.service`);
    expect(calls).toContain("--user daemon-reload");
  });

  it("is idempotent: reports removed:false when nothing was installed", () => {
    const io = {
      platform: "linux",
      home: "/home/u",
      existsSync: vi.fn(() => false),
      unlinkSync: vi.fn(),
      // disable of an absent unit returns non-zero; uninstall tolerates it.
      spawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "not loaded" })),
    };
    const r = uninstallService(io);
    expect(r.removed).toBe(false);
    expect(io.unlinkSync).not.toHaveBeenCalled();
  });

  it("darwin: returns manual unload/rm steps", () => {
    const r = uninstallService({ platform: "darwin", home: "/home/u" });
    expect(r).toMatchObject({ platform: "darwin", removed: false });
    expect(r.steps.join(" ")).toMatch(/launchctl unload/);
  });
});

describe("systemctlUser / resolveServicePaths", () => {
  it("systemctlUser never throws even when spawnSync throws", () => {
    const io = { spawnSync: () => { throw new Error("no systemctl"); } };
    const r = systemctlUser(["is-active", "x"], io);
    expect(r.status).toBe(null);
    expect(r.stderr).toMatch(/no systemctl/);
  });

  it("resolveServicePaths reflects the running node + PATH env", () => {
    const r = resolveServicePaths({ PATH: "/custom/bin" }, "/my/node");
    expect(r.nodePath).toBe("/my/node");
    expect(r.path).toBe("/custom/bin");
    expect(r.scriptPath).toMatch(/chorus\.mjs$/);
  });
});

// cli/__tests__/daemon-service.test.mjs
// Unit tests for the supervisor-service module: pure unit/plist rendering, the
// systemd detection probe, and the install/uninstall IO orchestration (all IO
// injected — no real systemctl / disk).
import { describe, it, expect, vi } from "vitest";
import {
  SERVICE_NAME,
  LAUNCHD_LABEL,
  systemdUnitPath,
  launchdPlistPath,
  buildServiceArgs,
  renderSystemdUnit,
  renderLaunchdPlist,
  detectSupervisor,
  autostartCapability,
  installService,
  uninstallService,
  systemctlUser,
  launchctl,
  resolveServicePaths,
  currentUserName,
  lingerStatus,
  ensureLinger,
  lingerMessages,
  currentUserId,
  LINGER_CALL_TIMEOUT_MS,
} from "../daemon-service.mjs";

/** The exact non-interactive SetUserLinger argv (uid 1000) the helper must spawn. */
const SET_LINGER_ARGV = [
  "busctl", "--system", "--allow-interactive-authorization=no", "--timeout=5s", "call",
  "org.freedesktop.login1", "/org/freedesktop/login1", "org.freedesktop.login1.Manager",
  "SetUserLinger", "ubb", "1000", "true", "false",
];

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

  it("returns kind:none on unsupported platforms (win32/other)", () => {
    expect(detectSupervisor(io({ platform: "win32" }))).toEqual({ kind: "none" });
    expect(detectSupervisor(io({ platform: "aix" }))).toEqual({ kind: "none" });
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

  it("darwin: reports launchd when the plist exists and launchctl lists it loaded", () => {
    const r = detectSupervisor(io({
      platform: "darwin",
      existsSync: () => true,
      spawnSync: () => ({ status: 0, stdout: "{ ... };\n", stderr: "" }), // launchctl list ok
    }));
    expect(r).toMatchObject({ kind: "launchd", installed: true, active: true, label: LAUNCHD_LABEL });
    expect(r.plistPath).toBe(launchdPlistPath({ home: "/home/u" }));
  });

  it("darwin: launchd installed-but-not-loaded when plist exists but launchctl list fails", () => {
    const r = detectSupervisor(io({
      platform: "darwin",
      existsSync: () => true,
      spawnSync: () => ({ status: 1, stdout: "", stderr: "Could not find service" }),
    }));
    expect(r).toMatchObject({ kind: "launchd", installed: true, active: false });
  });

  it("darwin: kind:none when neither the plist nor a loaded agent exists", () => {
    const r = detectSupervisor(io({
      platform: "darwin",
      existsSync: () => false,
      spawnSync: () => ({ status: 1, stdout: "", stderr: "" }),
    }));
    expect(r).toEqual({ kind: "none" });
  });
});

describe("autostartCapability", () => {
  it("returns launchd on darwin (launchctl is always present)", () => {
    expect(autostartCapability({ platform: "darwin", spawnSync: vi.fn() })).toBe("launchd");
  });

  it("returns systemd on linux when systemctl --user --version succeeds", () => {
    const io = { platform: "linux", spawnSync: vi.fn(() => ({ status: 0, stdout: "systemd 255\n", stderr: "" })) };
    expect(autostartCapability(io)).toBe("systemd");
  });

  it("returns unsupported on linux when systemctl is unavailable (status null)", () => {
    // spawnSync sets .error / null status when the binary is missing.
    const io = { platform: "linux", spawnSync: vi.fn(() => ({ status: null, error: new Error("ENOENT"), stdout: "", stderr: "" })) };
    expect(autostartCapability(io)).toBe("unsupported");
  });

  it("returns unsupported on linux when systemctl --version exits non-zero", () => {
    const io = { platform: "linux", spawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "no user bus" })) };
    expect(autostartCapability(io)).toBe("unsupported");
  });

  it("returns unsupported on win32 and other platforms", () => {
    expect(autostartCapability({ platform: "win32", spawnSync: vi.fn() })).toBe("unsupported");
    expect(autostartCapability({ platform: "aix", spawnSync: vi.fn() })).toBe("unsupported");
  });
});

describe("launchctl helper", () => {
  it("never throws when spawnSync throws", () => {
    const r = launchctl(["list"], { spawnSync: () => { throw new Error("no launchctl"); } });
    expect(r.status).toBe(null);
    expect(r.stderr).toMatch(/no launchctl/);
  });

  it("maps a spawnSync ENOENT error to a null status", () => {
    const r = launchctl(["list"], { spawnSync: () => ({ error: new Error("spawn launchctl ENOENT"), status: null, stdout: "", stderr: "" }) });
    expect(r.status).toBe(null);
    expect(r.stderr).toMatch(/ENOENT/);
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

  function darwinIO(over = {}) {
    const calls = [];
    return {
      io: {
        platform: "darwin",
        home: "/home/u",
        mkdirSync: vi.fn(),
        writeFileSync: vi.fn(),
        readFileSync: vi.fn(() => "old-plist"),
        existsSync: vi.fn(() => false),
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

  it("darwin: writes the plist and runs launchctl load -w (real install)", () => {
    const { io, calls } = darwinIO();
    const r = installService({ ...BASE }, io);
    expect(r).toMatchObject({ platform: "darwin", installed: true });
    const plistPath = launchdPlistPath({ home: "/home/u" });
    const writeCall = io.writeFileSync.mock.calls.find(([p]) => p === plistPath);
    expect(writeCall).toBeTruthy();
    expect(writeCall[1]).toContain("<plist");
    // load -w on the plist, preceded by a best-effort unload
    expect(calls).toContainEqual(["launchctl", "load", "-w", plistPath]);
    expect(calls.some((c) => c[0] === "launchctl" && c[1] === "unload")).toBe(true);
  });

  it("darwin: backs up an existing plist before overwrite", () => {
    const { io } = darwinIO({ existsSync: vi.fn(() => true) });
    installService({ ...BASE }, io);
    const bak = io.writeFileSync.mock.calls.find(([p]) => String(p).endsWith(".chorus-bak"));
    expect(bak).toBeTruthy();
  });

  it("darwin: returns installed:false + error when launchctl load -w fails", () => {
    const { io } = darwinIO({
      spawnSync: vi.fn((_c, args) => (args.includes("load") ? { status: 1, stdout: "", stderr: "Load failed: 5" } : { status: 0, stdout: "", stderr: "" })),
    });
    const r = installService({ ...BASE }, io);
    expect(r.installed).toBe(false);
    expect(r.error).toMatch(/launchctl load -w failed: Load failed: 5/);
  });

  it("darwin: never bakes credentials into the plist", () => {
    const { io } = darwinIO();
    const r = installService({ ...BASE }, io);
    expect(r.unitText).not.toContain("CHORUS_API_KEY");
    expect(r.unitText).not.toContain("CHORUS_URL");
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

  it("darwin: unloads and removes the plist (real uninstall)", () => {
    const calls = [];
    const io = {
      platform: "darwin",
      home: "/home/u",
      existsSync: vi.fn(() => true),
      unlinkSync: vi.fn(),
      spawnSync: vi.fn((cmd, args) => {
        calls.push([cmd, ...args]);
        return { status: 0, stdout: "", stderr: "" };
      }),
    };
    const r = uninstallService(io);
    const plistPath = launchdPlistPath({ home: "/home/u" });
    expect(r).toMatchObject({ platform: "darwin", removed: true });
    expect(calls).toContainEqual(["launchctl", "unload", "-w", plistPath]);
    expect(io.unlinkSync).toHaveBeenCalledWith(plistPath);
  });

  it("darwin: reports nothing-to-remove when the plist is absent", () => {
    const io = {
      platform: "darwin",
      home: "/home/u",
      existsSync: vi.fn(() => false),
      unlinkSync: vi.fn(),
      spawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "Could not find" })),
    };
    const r = uninstallService(io);
    expect(r.removed).toBe(false);
    expect(io.unlinkSync).not.toHaveBeenCalled();
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

describe("systemd lingering", () => {
  /**
   * A linux io whose loginctl answers are scripted per sub-command; every other
   * command (systemctl) succeeds. Records every spawn as [cmd, ...args].
   */
  function lingerIO({ show = { status: 0, stdout: "no\n", stderr: "" }, enable = { status: 0, stdout: "", stderr: "" }, user = "ubuntu", uid = 1000, ...over } = {}) {
    const calls = [];
    const optsSeen = [];
    const io = {
      platform: "linux",
      home: "/home/u",
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      existsSync: vi.fn(() => true),
      unlinkSync: vi.fn(),
      userInfo: () => ({ username: user, uid }),
      env: {},
      spawnSync: vi.fn((cmd, args, opts) => {
        calls.push([cmd, ...args]);
        // never through a shell — argv only
        expect(opts?.shell).toBeFalsy();
        if (cmd === "loginctl" || cmd === "busctl") optsSeen.push(opts);
        if (cmd === "loginctl" && args[0] === "show-user") return typeof show === "function" ? show() : show;
        if (cmd === "busctl" && args.includes("SetUserLinger")) return typeof enable === "function" ? enable() : enable;
        return { status: 0, stdout: "", stderr: "" };
      }),
      ...over,
    };
    return {
      io,
      calls,
      optsSeen,
      loginctlCalls: () => calls.filter((c) => c[0] === "loginctl" || c[0] === "busctl"),
    };
  }

  describe("currentUserName", () => {
    it("prefers os.userInfo().username", () => {
      expect(currentUserName({ userInfo: () => ({ username: "alice" }), env: { USER: "bob" } })).toBe("alice");
    });
    it("falls back to $USER then $LOGNAME when userInfo throws", () => {
      const throwing = () => { throw new Error("no passwd entry"); };
      expect(currentUserName({ userInfo: throwing, env: { USER: "bob" } })).toBe("bob");
      expect(currentUserName({ userInfo: throwing, env: { LOGNAME: "carol" } })).toBe("carol");
    });
    it("returns null when nothing resolves", () => {
      expect(currentUserName({ env: {} })).toBe(null);
    });
  });

  describe("currentUserId", () => {
    it("prefers os.userInfo().uid, then getuid, else null", () => {
      expect(currentUserId({ userInfo: () => ({ uid: 1001 }), getuid: () => 5 })).toBe(1001);
      expect(currentUserId({ userInfo: () => { throw new Error("x"); }, getuid: () => 5 })).toBe(5);
      expect(currentUserId({})).toBe(null);
    });
  });

  describe("lingerStatus", () => {
    it("queries show-user with the explicit user and --value", () => {
      const { io, calls } = lingerIO({ show: { status: 0, stdout: "yes\n", stderr: "" } });
      expect(lingerStatus(io)).toEqual({ state: "yes", user: "ubuntu" });
      expect(calls).toEqual([["loginctl", "show-user", "ubuntu", "-p", "Linger", "--value"]]);
    });
    it("reports no", () => {
      const { io } = lingerIO();
      expect(lingerStatus(io).state).toBe("no");
    });
    it("tolerates the Linger=yes form (no --value support)", () => {
      const { io } = lingerIO({ show: { status: 0, stdout: "Linger=yes\n", stderr: "" } });
      expect(lingerStatus(io).state).toBe("yes");
    });
    it("is unknown (never throws) on a non-zero exit", () => {
      const { io } = lingerIO({ show: { status: 1, stdout: "", stderr: "Failed to get user: No such user" } });
      const r = lingerStatus(io);
      expect(r.state).toBe("unknown");
      expect(r.error).toMatch(/No such user/);
    });
    it("is unknown (never throws) when loginctl is missing", () => {
      const { io } = lingerIO({ show: { status: null, error: new Error("spawn loginctl ENOENT"), stdout: "", stderr: "" } });
      const r = lingerStatus(io);
      expect(r.state).toBe("unknown");
      expect(r.error).toMatch(/ENOENT/);
    });
    it("is unknown when spawnSync throws", () => {
      const r = lingerStatus({ userInfo: () => ({ username: "u" }), spawnSync: () => { throw new Error("boom"); } });
      expect(r.state).toBe("unknown");
    });
    it("is unknown on unparseable output", () => {
      const { io } = lingerIO({ show: { status: 0, stdout: "maybe", stderr: "" } });
      expect(lingerStatus(io).state).toBe("unknown");
    });
    it("is unknown without a resolvable user and makes no call", () => {
      const { io, calls } = lingerIO({ userInfo: undefined });
      expect(lingerStatus(io)).toMatchObject({ state: "unknown", user: null });
      expect(calls).toEqual([]);
    });
  });

  describe("ensureLinger", () => {
    it("already: no SetUserLinger call when lingering is on", () => {
      const { io, calls } = lingerIO({ show: { status: 0, stdout: "yes", stderr: "" } });
      expect(ensureLinger(io)).toEqual({ result: "already", user: "ubuntu" });
      expect(calls.some((c) => c[0] === "busctl")).toBe(false);
    });
    it("enabled: calls SetUserLinger(uid, true, interactive=false) with interactive auth forbidden", () => {
      const { io, calls } = lingerIO();
      expect(ensureLinger(io)).toEqual({ result: "enabled", user: "ubuntu" });
      expect(calls).toContainEqual(SET_LINGER_ARGV);
      // never the interactive loginctl enable path (B1)
      expect(calls.some((c) => c[0] === "loginctl" && c[1] === "enable-linger")).toBe(false);
    });
    it("every logind spawn carries a finite timeout", () => {
      const { io, optsSeen } = lingerIO();
      ensureLinger(io);
      expect(optsSeen.length).toBe(2);
      for (const o of optsSeen) {
        expect(Number.isFinite(o.timeout)).toBe(true);
        expect(o.timeout).toBe(LINGER_CALL_TIMEOUT_MS);
      }
    });
    it("a spawn timeout (ETIMEDOUT) falls back to the sudo fix instead of hanging", () => {
      const timedOut = { status: null, signal: "SIGTERM", error: Object.assign(new Error("spawnSync busctl ETIMEDOUT"), { code: "ETIMEDOUT" }), stdout: "", stderr: "" };
      const { io } = lingerIO({ enable: timedOut });
      const r = ensureLinger(io);
      expect(r).toMatchObject({ result: "failed", fix: "sudo loginctl enable-linger ubuntu" });
      expect(r.error).toMatch(/ETIMEDOUT/);
    });
    it("a signal-killed call without error is reported as a failure", () => {
      const { io } = lingerIO({ enable: { status: null, signal: "SIGKILL", stdout: "", stderr: "" } });
      const r = ensureLinger(io);
      expect(r.result).toBe("failed");
      expect(r.error).toMatch(/SIGKILL/);
    });
    it("uses the uid from os.userInfo, falling back to getuid", () => {
      const { io, calls } = lingerIO({ userInfo: () => ({ username: "ubuntu" }), getuid: () => 1234 });
      ensureLinger(io);
      expect(calls.find((c) => c[0] === "busctl")).toContain("1234");
    });
    it("unavailable without a uid: no SetUserLinger call", () => {
      const { io, calls } = lingerIO({ userInfo: () => ({ username: "ubuntu" }) });
      const r = ensureLinger(io);
      expect(r).toMatchObject({ result: "unavailable", fix: "sudo loginctl enable-linger ubuntu" });
      expect(calls.some((c) => c[0] === "busctl")).toBe(false);
    });
    it("failed: SetUserLinger denied (polkit, non-interactive) carries the sudo fix", () => {
      const { io } = lingerIO({ enable: { status: 1, stdout: "", stderr: "Call failed: Access denied" } });
      const r = ensureLinger(io);
      expect(r).toMatchObject({ result: "failed", user: "ubuntu", fix: "sudo loginctl enable-linger ubuntu" });
      expect(r.error).toMatch(/Access denied/);
    });
    it("unknown state still attempts SetUserLinger and can succeed", () => {
      const { io, calls } = lingerIO({ show: { status: 1, stdout: "", stderr: "No such user" } });
      expect(ensureLinger(io)).toEqual({ result: "enabled", user: "ubuntu" });
      expect(calls).toContainEqual(SET_LINGER_ARGV);
    });
    it("unavailable: loginctl/busctl missing carries the sudo fix", () => {
      const missing = { status: null, error: new Error("spawn ENOENT"), stdout: "", stderr: "" };
      const { io } = lingerIO({ show: missing, enable: missing });
      const r = ensureLinger(io);
      expect(r).toMatchObject({ result: "unavailable", user: "ubuntu", fix: "sudo loginctl enable-linger ubuntu" });
      expect(r.error).toMatch(/ENOENT/);
    });
    it("unavailable without a user: no loginctl call, generic fix", () => {
      const { io, calls } = lingerIO({ userInfo: undefined });
      const r = ensureLinger(io);
      expect(r).toMatchObject({ result: "unavailable", user: null });
      expect(r.fix).toMatch(/sudo loginctl enable-linger/);
      expect(calls).toEqual([]);
    });
  });

  describe("lingerMessages", () => {
    it("prints nothing for skipped / already / undefined", () => {
      expect(lingerMessages(undefined)).toEqual([]);
      expect(lingerMessages({ result: "skipped" })).toEqual([]);
      expect(lingerMessages({ result: "already", user: "u" })).toEqual([]);
    });
    it("one info line when enabled", () => {
      const m = lingerMessages({ result: "enabled", user: "u" });
      expect(m).toHaveLength(1);
      expect(m[0].level).toBe("info");
      expect(m[0].text).toMatch(/lingering/);
    });
    it("warn lines with the sudo fix on failure", () => {
      const m = lingerMessages({ result: "failed", user: "u", error: "denied", fix: "sudo loginctl enable-linger u" });
      expect(m.every((x) => x.level === "warn")).toBe(true);
      const text = m.map((x) => x.text).join("\n");
      expect(text).toContain("sudo loginctl enable-linger u");
      expect(text).toMatch(/log out/);
    });
  });

  describe("installService linger integration", () => {
    it("Linux success ensures lingering and records the step", () => {
      const { io, calls } = lingerIO();
      const r = installService({ ...BASE }, io);
      expect(r.installed).toBe(true);
      expect(r.linger).toEqual({ result: "enabled", user: "ubuntu" });
      expect(r.steps).toContain("enabled lingering for ubuntu (logind SetUserLinger)");
      // linger runs only after the unit is enabled
      const enableIdx = calls.findIndex((c) => c[0] === "systemctl" && c.includes("enable"));
      const lingerIdx = calls.findIndex((c) => c[0] === "loginctl");
      expect(calls).toContainEqual(SET_LINGER_ARGV);
      expect(lingerIdx).toBeGreaterThan(enableIdx);
    });
    it("noLinger skips every loginctl call", () => {
      const { io, loginctlCalls } = lingerIO();
      const r = installService({ ...BASE, noLinger: true }, io);
      expect(r.installed).toBe(true);
      expect(r.linger).toEqual({ result: "skipped" });
      expect(loginctlCalls()).toEqual([]);
    });
    it("a linger failure does not fail the install", () => {
      const { io } = lingerIO({ enable: { status: 1, stdout: "", stderr: "Access denied" } });
      const r = installService({ ...BASE }, io);
      expect(r.installed).toBe(true);
      expect(r.error).toBeUndefined();
      expect(r.linger.result).toBe("failed");
    });
    it("a failed unit install does not attempt lingering", () => {
      const { io, loginctlCalls } = lingerIO({
        spawnSync: vi.fn((cmd, args) => (cmd === "systemctl" && args.includes("enable") ? { status: 1, stdout: "", stderr: "nope" } : { status: 0, stdout: "no", stderr: "" })),
      });
      const r = installService({ ...BASE }, io);
      expect(r.installed).toBe(false);
      expect(r.linger).toBeUndefined();
      expect(loginctlCalls()).toEqual([]);
    });
    it("darwin and other platforms never call loginctl", () => {
      for (const platform of ["darwin", "win32"]) {
        const { io } = lingerIO({ platform, readFileSync: vi.fn(() => "") });
        installService({ ...BASE }, io);
        expect(io.spawnSync.mock.calls.some((c) => c[0] === "loginctl" || c[0] === "busctl")).toBe(false);
      }
    });
    it("uninstall never disables lingering", () => {
      const { io } = lingerIO();
      uninstallService(io);
      expect(io.spawnSync.mock.calls.some((c) => c[0] === "loginctl" || c[0] === "busctl")).toBe(false);
    });
  });
});

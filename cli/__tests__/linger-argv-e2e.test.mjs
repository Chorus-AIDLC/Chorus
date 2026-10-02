// cli/__tests__/linger-argv-e2e.test.mjs
// End-to-end `--no-linger` coverage from RAW argv (code-review N1): drive the real
// arg parsers → the real dispatcher (runDaemon / runAgents → runInit → daemon-setup)
// → the REAL installService, with only the leaf service IO faked. Asserts the unit is
// still installed and that NO logind call (loginctl / busctl) is ever spawned — and,
// as the control, that the same run WITHOUT --no-linger does make the
// non-interactive SetUserLinger call.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClientFlags, parseDaemonAction } from "../client-args.mjs";
import { runDaemon } from "../daemon.mjs";
import { runAgents } from "../agents.mjs";
import { runInit } from "../init.mjs";
import { daemonSetupStep } from "../init/steps/daemon-setup.mjs";
import { installService, resolveServicePaths } from "../daemon-service.mjs";

// Isolate from the developer's real ~/.chorus (same as the sibling runDaemon suites).
const REAL_HOME = process.env.HOME;
const TMP_HOME = mkdtempSync(join(tmpdir(), "chorus-linger-e2e-home-"));
beforeAll(() => {
  process.env.HOME = TMP_HOME;
});
afterAll(() => {
  process.env.HOME = REAL_HOME;
  rmSync(TMP_HOME, { recursive: true, force: true });
});

/** A fake linux service IO: unit not yet installed, Linger=no, every call succeeds. */
function fakeServiceIo() {
  const spawnCalls = [];
  const io = {
    platform: "linux",
    home: "/home/u",
    mkdirSync: () => {},
    writeFileSync: () => {},
    existsSync: () => false,
    unlinkSync: () => {},
    userInfo: () => ({ username: "u", uid: 1000 }),
    env: {},
    spawnSync: (cmd, args) => {
      spawnCalls.push([cmd, ...(args ?? [])]);
      if (cmd === "loginctl" && args?.[0] === "show-user") return { status: 0, stdout: "no\n", stderr: "" };
      return { status: 0, stdout: "systemd 255", stderr: "" };
    },
  };
  const logind = () => spawnCalls.filter((c) => c[0] === "loginctl" || c[0] === "busctl");
  const enabled = () => spawnCalls.some((c) => c[0] === "systemctl" && c.includes("enable"));
  return { io, spawnCalls, logind, enabled };
}

/** Exactly what chorus.mjs does for `chorus daemon …`: parse, then dispatch. */
async function chorusDaemon(argv, io) {
  const flags = parseClientFlags(argv);
  const action = parseDaemonAction(argv);
  const service = {
    detectSupervisor: () => ({ kind: "none" }),
    installService: (spec) => installService(spec, io), // the REAL installService
    resolveServicePaths: () => resolveServicePaths({ PATH: "/usr/bin:/bin" }),
    installConfig: {
      resolveInstallCredentials: vi.fn(async () => ({ ok: true, creds: { url: "u", apiKey: "cho_k" }, identity: { uuid: "a", name: "Bot" } })),
      resolveInstallCwds: vi.fn(async () => ({ cwds: ["/a"] })),
      resolveInstallAgent: vi.fn(async () => ({ ok: true, agent: "claude-code", cliPath: "/bin/claude", cliFound: true })),
    },
  };
  return runDaemon({ ...flags, action }, { service, log: () => {}, errLog: () => {}, env: {}, isTTY: false });
}

/** `chorus agents add <argv>` → runAgents → runInit → the real daemon-setup step. */
async function chorusAgentsAdd(argv, io) {
  const deps = {
    env: { PATH: "/usr/bin:/bin" },
    io: { log: () => {}, isTTY: false },
    detectAgents: async () => [{ id: "claude", displayName: "Claude Code", binaryOnPath: false, configDirPresent: false, detected: false }],
    resolveSelection: async () => ({ selectedIds: ["claude"] }),
    orderedSteps: () => [daemonSetupStep],
    ctxExtras: {
      serviceIo: io,
      writeConfig: () => "/home/u/.chorus/daemon.json",
      readJson: () => ({ agents: [{ agentType: "claude-code", daemonWake: true }] }),
      resolve: () => ({ url: "https://c.example", apiKey: "cho_k", source: "env" }),
      validate: async () => ({ uuid: "agent-1", name: "Bot" }),
      processCwd: "/proj",
    },
  };
  let forwarded;
  const code = await runAgents(["add", ...argv], {
    runInit: (a, o) => {
      forwarded = a;
      return runInit(a, { ...o, ...deps });
    },
  });
  return { code, forwarded };
}

describe("--no-linger end-to-end from raw argv", () => {
  it("`chorus daemon install --no-linger` installs the unit and makes no logind call", async () => {
    const f = fakeServiceIo();
    const code = await chorusDaemon(["install", "--no-linger", "--yes"], f.io);
    expect(code).toBe(0);
    expect(f.enabled()).toBe(true);
    expect(f.logind()).toEqual([]);
  });

  it("control: `chorus daemon install` (no flag) enables lingering non-interactively", async () => {
    const f = fakeServiceIo();
    const code = await chorusDaemon(["install", "--yes"], f.io);
    expect(code).toBe(0);
    const set = f.logind().find((c) => c[0] === "busctl");
    expect(set).toContain("--allow-interactive-authorization=no");
    expect(set.slice(-3)).toEqual(["1000", "true", "false"]);
  });

  it("`chorus agents add --no-linger` installs the unit and makes no logind call", async () => {
    const f = fakeServiceIo();
    const { code, forwarded } = await chorusAgentsAdd(["--agents", "claude", "--yes", "--daemon-autostart", "--no-linger"], f.io);
    expect(code).toBe(0);
    expect(forwarded).toContain("--no-linger");
    expect(f.enabled()).toBe(true);
    expect(f.logind()).toEqual([]);
  });

  it("control: `chorus agents add` (no flag) enables lingering non-interactively", async () => {
    const f = fakeServiceIo();
    const { code } = await chorusAgentsAdd(["--agents", "claude", "--yes", "--daemon-autostart"], f.io);
    expect(code).toBe(0);
    expect(f.logind().some((c) => c[0] === "busctl" && c.includes("SetUserLinger"))).toBe(true);
  });
});

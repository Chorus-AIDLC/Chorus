import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { transcriptPath } from "../claude-spawner.mjs";
import { hasChorusMcpServer } from "../codex-spawner.mjs";
import { prepareManagedDshConfig, RUNTIME_IDENTITY } from "../dsh-managed-config.mjs";
import { describe, it, expect, vi } from "vitest";
import { selectSpawner } from "../spawner-select.mjs";
import { runAgentLaunch } from "../agent-launcher.mjs";
import { resolveAgentConfigs } from "../daemon-config.mjs";
import { buildDaemon, buildMultiAgentDaemon, runDaemon } from "../daemon.mjs";

const UUID = "11111111-2222-4333-8444-555555555555";
const creds = { url: "https://chorus.test", apiKey: "cho_test", agentUuid: UUID };
const silent = { info() {}, warn() {}, error() {} };
const wake = { sessionId: UUID, prompt: "private wake prompt", isNew: true, cwd: "/work" };
function fakeSpawn(type) {
  return vi.fn(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.stdout.setEncoding = child.stderr.setEncoding = () => {};
    child.stdin.write = vi.fn((text) => {
      if (type !== "dsh") return true;
      const req = JSON.parse(text);
      const send = (data) => child.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", ...data }) + "\n");
      queueMicrotask(() => {
        send({ id: req.id, result: req.method === "initialize" ? { serverInfo: { name: "deepseek-harness-sdk-runtime" } } : { messageId: "receipt" } });
        if (req.method === "session/prompt") {
          send({ method: "session.event", params: { sessionId: req.params.sessionId, event: { type: "agent/inbox/spliced", data: { inserted: [{ id: "receipt" }] } } } });
          send({ method: "session.status", params: { sessionId: req.params.sessionId, status: "idle" } });
        }
      });
      return true;
    });
    child.stdin.end = () => queueMicrotask(() => child.emit("close", 0));
    child.kill = () => {};
    if (type === "foreground") queueMicrotask(() => child.emit("close", 0));
    return child;
  });
}
function backendOpts(type, overrides = {}) {
  return {
    env: { PATH: "/base", CLAUDECODE: "nested" }, platform: "linux", logger: silent, creds,
    [`${type === "claude-code" ? "claude" : type}Path`]: `/fake/${type}`,
    spawnImpl: fakeSpawn(type), getThreadIdFn: () => null, getUsageSnapshotFn: () => null,
    getSessionIdFn: () => null, snapshotSessionsFn: () => new Set(), reconstructTranscript: null,
    hasChorusMcpServerFn: () => true, prepareManagedConfigFn: async () => ({ home: "/managed" }),
    timeoutMs: 100, shutdownTimeoutMs: 100, ...overrides,
  };
}
const types = ["claude-code", "codex", "kiro", "pi", "dsh"];
describe("actual daemon spawn customization", () => {
  for (const type of types) {
    it.each([false, true])(`${type} fresh/resumed=%s literal argv/env and fixed controls`, async (resumed) => {
      const args = ["--custom=space $HOME ; & `literal`", "--other=literal"];
      const config = { args, env: { TOKEN: "${TOKEN} literal", PATH: "/profile", DSH_PROVIDER: "provider-x", DSH_MODEL: "model-x" } };
      const prepare = vi.fn(async () => ({ home: "/managed" }));
      const opts = backendOpts(type, { cliConfig: config, getThreadIdFn: () => resumed ? "thread-1" : null, getSessionIdFn: () => resumed ? "session-1" : null, prepareManagedConfigFn: prepare });
      const spawner = selectSpawner(type, opts);
      const result = await spawner.wake({ ...wake, isNew: !resumed });
      expect(result.exitCode).toBe(0);
      const [command, argv, options] = opts.spawnImpl.mock.calls[0];
      expect(command).toBe(`/fake/${type}`);
      const sentinel = type === "pi" || type === "codex";
      expect(argv.slice(sentinel ? -args.length - 1 : -args.length, sentinel ? -1 : undefined)).toEqual(args);
      expect(argv).not.toContain(wake.prompt);
      expect(options).toMatchObject({ shell: false, cwd: "/work", env: { TOKEN: "${TOKEN} literal", PATH: "/profile", CHORUS_DAEMON_HEADLESS: "1", CHORUS_AGENT_PROFILE: UUID } });
      expect(opts.env).toEqual({ PATH: "/base", CLAUDECODE: "nested" });
      if (type === "claude-code") { expect(options.env.CLAUDECODE).toBeUndefined(); expect(argv).toContain(resumed ? "--resume" : "--session-id"); }
      if (type === "codex") { expect(argv.at(-1)).toBe("-"); expect(argv.slice(0, resumed ? 3 : 1)).toEqual(resumed ? ["exec", "resume", "thread-1"] : ["exec"]); expect(argv).toContain("--json"); }
      if (type === "kiro") expect(argv.slice(0, 2)).toEqual(["chat", "--no-interactive"]);
      if (type === "pi") expect(argv.at(-1)).toBe("-p");
      if (type === "dsh") {
        expect(argv.slice(0, 2)).toEqual(["--profile", "sdk"]);
        expect(prepare.mock.calls[0][0].env).toMatchObject(config.env);
        const child = opts.spawnImpl.mock.results[0].value;
        expect(JSON.parse(child.stdin.write.mock.calls[0][0]).params).toMatchObject({ provider: "provider-x", model: "model-x" });
      }
    });
    it(`${type} absent and empty customization spawn identically`, async () => {
      const a = backendOpts(type); const b = backendOpts(type, { cliConfig: { args: [], env: {} } });
      await selectSpawner(type, a).wake(wake); await selectSpawner(type, b).wake(wake);
      expect(a.spawnImpl.mock.calls).toEqual(b.spawnImpl.mock.calls);
    });
    it(`${type} native Windows spawn preserves metacharacters literally`, async () => {
      const args = ["--custom=a b & %VAR% ! ^ | < > ( )"]; const opts = backendOpts(type, {
        platform: "win32", [`${type === "claude-code" ? "claude" : type}Path`]: "C:\\bin\\agent.exe",
        cliConfig: { args, env: { TOKEN: "${TOKEN} & %TOKEN%" } },
      });
      await selectSpawner(type, opts).wake(wake);
      const [command, argv, options] = opts.spawnImpl.mock.calls[0];
      expect(command).toBe("C:\\bin\\agent.exe"); expect(argv).toContain(args[0]);
      expect(options).toMatchObject({ shell: false, env: { TOKEN: "${TOKEN} & %TOKEN%" } });
    });
    it(`${type} uses mixed-case Windows COMSPEC at the actual shim spawn`, async () => {
      const opts = backendOpts(type, {
        platform: "win32", env: { COMSPEC: "C:\\base\\cmd.exe" },
        [`${type === "claude-code" ? "claude" : type}Path`]: "C:\\bin\\agent.cmd",
        cliConfig: { env: { cOmSpEc: "C:\\profile\\cmd.exe" } },
      });
      await selectSpawner(type, opts).wake(wake);
      expect(opts.spawnImpl).toHaveBeenCalledTimes(1);
      const [command, argv, options] = opts.spawnImpl.mock.calls[0];
      expect(command).toBe("C:\\profile\\cmd.exe");
      expect(argv.slice(0, 4)).toEqual(["/d", "/s", "/c", "C:\\bin\\agent.cmd"]);
      expect(options.env.cOmSpEc).toBe(command);
      expect(options.env.COMSPEC).toBeUndefined();
    });
    it(`${type} refuses configured protocol/env or unsafe shim argv before spawn`, async () => {
      const opts = backendOpts(type);
      expect(() => selectSpawner(type, { ...opts, cliConfig: { args: ["--"] } })).toThrow();
      expect(() => selectSpawner(type, { ...opts, cliConfig: { env: { chorus_url: "secret" } } })).toThrow();
      const shim = selectSpawner(type, { ...opts, platform: "win32", [`${type === "claude-code" ? "claude" : type}Path`]: "C:\\bin\\agent.cmd", cliConfig: { args: ["--custom=%SECRET%&echo"] } });
      await expect(shim.wake(wake)).rejects.toThrow(/native executable/);
      expect(opts.spawnImpl).not.toHaveBeenCalled();
    });
  }
  it("offline never spawns", async () => {
    const opts = backendOpts("offline", { cliConfig: { args: ["--model=x"], env: { TOKEN: "x" } } });
    await selectSpawner("offline", opts).wake(wake);
    expect(opts.spawnImpl).not.toHaveBeenCalled();
  });
  it("Kiro session discovery and reconstruction use the child's home", async () => {
    const snapshotSessionsFn = vi.fn(() => new Map()); const reconstructTranscript = vi.fn();
    const opts = backendOpts("kiro", { cliConfig: { env: { HOME: "/profile-home" } }, snapshotSessionsFn, reconstructTranscript });
    await selectSpawner("kiro", opts).wake(wake);
    expect(snapshotSessionsFn.mock.calls[0][1].dir).toBe("/profile-home/.kiro/sessions/cli");
    expect(reconstructTranscript.mock.calls[0][0].dir).toBe("/profile-home/.kiro/sessions/cli");
    expect(opts.spawnImpl.mock.calls[0][2].env.HOME).toBe("/profile-home");
  });
  it("dsh custom DSH_HOME skips managed setup without losing the child override", async () => {
    const prepare = vi.fn();
    const opts = backendOpts("dsh", { cliConfig: { env: { DSH_HOME: "/sdk-profile" } }, prepareManagedConfigFn: prepare });
    await selectSpawner("dsh", opts).wake(wake);
    expect(prepare).not.toHaveBeenCalled();
    expect(opts.spawnImpl.mock.calls[0][2].env.DSH_HOME).toBe("/sdk-profile");
  });
  it.each(["DSH_HOME", "dsh_home", "dSh_HoMe"])("Windows dsh %s skips setup and remains the sole child home", async (key) => {
    const prepare = vi.fn();
    const opts = backendOpts("dsh", {
      platform: "win32", env: { DSH_HOME: "C:\\inherited", DSH_CWD: "C:\\stale" },
      cliConfig: { env: { [key]: "C:\\sdk-profile", dsh_cwd: "C:\\unmanaged", dSh_PrOvIdEr: "provider-x", dsh_model: "model-x" } },
      prepareManagedConfigFn: prepare,
    });
    await selectSpawner("dsh", opts).wake(wake);
    expect(prepare).not.toHaveBeenCalled();
    expect(opts.spawnImpl).toHaveBeenCalledTimes(1);
    const env = opts.spawnImpl.mock.calls[0][2].env;
    expect(env.DSH_HOME).toBe("C:\\sdk-profile");
    expect(Object.keys(env).filter((k) => k.toUpperCase() === "DSH_HOME")).toEqual(["DSH_HOME"]);
    expect(env.DSH_CWD).toBe(wake.cwd);
    expect(Object.keys(env).filter((k) => k.toUpperCase() === "DSH_CWD")).toEqual(["DSH_CWD"]);
    const child = opts.spawnImpl.mock.results[0].value;
    expect(JSON.parse(child.stdin.write.mock.calls[0][0]).params).toMatchObject({ provider: "provider-x", model: "model-x" });
    expect(opts.env.DSH_HOME).toBe("C:\\inherited");
    expect(opts.cliConfig.env[key]).toBe("C:\\sdk-profile");
  });
  it.each(["home", "uSeRpRoFiLe"])("Windows dsh managed setup and runtime share %s/provider/model", async (key) => {
    const home = mkdtempSync(join(tmpdir(), "chorus-dsh-env-"));
    try {
      const runner = vi.fn(() => ({ stdout: JSON.stringify({ id: 1, result: { serverInfo: { name: RUNTIME_IDENTITY } } }) }));
      const prepare = vi.fn((opts) => prepareManagedDshConfig({
        ...opts, runtimeVersion: "test", validateProfile: () => {}, runCommand: runner,
      }));
      const opts = backendOpts("dsh", {
        platform: "win32", env: {}, bundleVersion: "0.18.0", prepareManagedConfigFn: prepare,
        cliConfig: { env: { [key]: home, dSh_PrOvIdEr: "provider-x", dsh_model: "model-x", dsh_cwd: "stale" } },
      });
      await selectSpawner("dsh", opts).wake(wake);
      expect(prepare.mock.calls[0][0].platform).toBe("win32");
      expect(runner).toHaveBeenCalledTimes(2); // install + real composition probe, no live CLI
      const childEnv = opts.spawnImpl.mock.calls[0][2].env;
      expect(childEnv.DSH_HOME.startsWith(join(home, ".chorus", "dsh", "releases"))).toBe(true);
      const installEnv = runner.mock.calls[0][2].env;
      const probe = runner.mock.calls[1][2];
      expect(installEnv.DSH_HOME).toBe(childEnv.DSH_HOME);
      expect(probe.env.DSH_HOME).toBe(childEnv.DSH_HOME);
      expect(probe.env.dsh_cwd).toBeUndefined();
      expect(probe.env.DSH_CWD).toBe(childEnv.DSH_HOME);
      expect(JSON.parse(probe.input).params.provider).toBe("provider-x");
      expect(runner.mock.calls[1][1]).toContain("--patch");
      const child = opts.spawnImpl.mock.results[0].value;
      expect(JSON.parse(child.stdin.write.mock.calls[0][0]).params).toMatchObject({ provider: "provider-x", model: "model-x" });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it.each(["home", "uSeRpRoFiLe"])("Windows Kiro discovery/reconstruction uses %s from child env", async (key) => {
    const snapshotSessionsFn = vi.fn(() => new Map()); const reconstructTranscript = vi.fn();
    const opts = backendOpts("kiro", { platform: "win32", env: {}, cliConfig: { env: { [key]: "/profile-home" } }, snapshotSessionsFn, reconstructTranscript });
    await selectSpawner("kiro", opts).wake(wake);
    expect(snapshotSessionsFn.mock.calls[0][1].dir).toBe(join("/profile-home", ".kiro", "sessions", "cli"));
    expect(reconstructTranscript.mock.calls[0][0].dir).toBe(join("/profile-home", ".kiro", "sessions", "cli"));
    expect(opts.spawnImpl.mock.calls[0][2].env[key]).toBe("/profile-home");
  });
  it.each(["codex_home", "CoDeX_HoMe", "home", "uSeRpRoFiLe"])("Windows Codex preflight actually reads configured %s", async (key) => {
    const readFile = vi.fn(() => "[mcp_servers.chorus]\n");
    const hasChorusMcpServerFn = vi.fn((deps) => hasChorusMcpServer({ ...deps, readFile }));
    const opts = backendOpts("codex", { platform: "win32", env: {}, cliConfig: { env: { [key]: "/profile-home" } }, hasChorusMcpServerFn });
    await selectSpawner("codex", opts).wake(wake);
    expect(hasChorusMcpServerFn).toHaveReturnedWith(true);
    expect(readFile).toHaveBeenCalledWith(join("/profile-home", ...(key.toUpperCase() === "CODEX_HOME" ? [] : [".codex"]), "config.toml"), "utf8");
    expect(opts.spawnImpl.mock.calls[0][2].env[key]).toBe("/profile-home");
  });
  it("Codex discovery and MCP preflight use effective config home and PATH", async () => {
    const resolveCodexPathFn = vi.fn(() => "/profile/codex"); const hasChorusMcpServerFn = vi.fn(() => true);
    const opts = backendOpts("codex", { codexPath: null, resolveCodexPathFn, hasChorusMcpServerFn, cliConfig: { env: { CODEX_HOME: "/private-home", PATH: "/profile" } } });
    await selectSpawner("codex", opts).wake(wake);
    expect(resolveCodexPathFn.mock.calls[0][0].env.CODEX_HOME).toBe("/private-home");
    expect(hasChorusMcpServerFn.mock.calls[0][0].env.PATH).toBe("/profile");
    expect(opts.spawnImpl.mock.calls[0][2].env.CODEX_HOME).toBe("/private-home");
  });
});

function launchOpts(file, overrides = {}) {
  return { env: { PATH: "/base", CHORUS_DAEMON_HEADLESS: "1", CLAUDECODE: "nested" }, loginPath: "/config", settingsPath: "/settings", readJson: (p) => p === "/config" ? file : null,
    platform: "linux", isFile: () => true, spawnImpl: fakeSpawn("foreground"), stdout: { write() {} }, stderr: { write() {} }, ...overrides };
}
describe("actual foreground launches", () => {
  it.each([
    ["claude-code", ["--brief", "PRIVATE-PROMPT"]],
    ["codex", ["--oss", "PRIVATE-PROMPT"]],
    ["kiro", ["--require-mcp-startup", "PRIVATE-PROMPT"]],
    ["pi", ["--verbose", "PRIVATE-PROMPT"]],
    ["pi", ["-nt", "PRIVATE-PROMPT"]],
    ["dsh", ["--unknown", "PRIVATE-PROMPT"]],
    ["opencode", ["--print-logs", "PRIVATE-PROMPT"]],
    ["openclaw", ["--deliver", "PRIVATE-PROMPT"]],
    ["pi", ["--api-key"]],
    ["pi", ["--api-key", "--"]],
  ])("%s arity failure prevents daemon and foreground spawn", async (type, args) => {
    const daemon = backendOpts(type, { cliConfig: { args } });
    if (types.includes(type)) {
      expect(() => selectSpawner(type, daemon)).toThrow();
      expect(daemon.spawnImpl).not.toHaveBeenCalled();
    }
    const stderr = { write: vi.fn() };
    const foreground = launchOpts({ agents: [{ agentType: type, args }] }, { stderr });
    expect(await runAgentLaunch([], foreground)).toBe(1);
    expect(foreground.spawnImpl).not.toHaveBeenCalled();
    expect(stderr.write.mock.calls.flat().join()).not.toContain("PRIVATE-PROMPT");
  });
  it.each([
    ["claude-code", ["--plugin-dir", "--model"]],
    ["codex", ["--enable", "--model"]],
    ["kiro", ["--wrap", "--model"]],
    ["pi", ["-e", "--model"]],
    ["dsh", ["--custom=--model"]],
    ["opencode", ["--log-level", "--model"]],
    ["openclaw", ["--reply-to", "--model"]],
  ])("%s preserves literal configured values at real spawn seam", async (type, args) => {
    if (types.includes(type)) {
      const daemon = backendOpts(type, { cliConfig: { args } });
      await selectSpawner(type, daemon).wake(wake);
      const argv = daemon.spawnImpl.mock.calls[0][1];
      const sentinel = ["pi", "codex"].includes(type);
      expect(argv.slice(-args.length - Number(sentinel), sentinel ? -1 : undefined)).toEqual(args);
    }
    const foreground = launchOpts({ agents: [{ agentType: type, args }] });
    expect(await runAgentLaunch(["--", "--model", "new"], foreground)).toBe(0);
    expect(foreground.spawnImpl.mock.calls[0][1]).toEqual([...args, "--model", "new"]);
  });
  it.each([
    [["--append-system-prompt", "--model"], true],
    [["--append-system-prompt=--model", "--model", "new"], false],
    [["--append-system-prompt", "literal", "--model", "new"], false],
    [["-e", "--model"], true],
    [["-nt", "--model", "new"], false],
    [["--future", "--model", "new"], true],
    [["--future", "opaque", "--model", "new"], true],
    [["--", "--model", "new"], true],
    [["--append-system-prompt", "--", "--model", "new"], true],
  ])("Pi foreground scan only suppresses unambiguous switches: %j", async (tail, keep) => {
    const args = ["--model", "old"];
    const foreground = launchOpts({ agents: [{ agentType: "pi", args }] });
    expect(await runAgentLaunch(["--", ...tail], foreground)).toBe(0);
    expect(foreground.spawnImpl.mock.calls[0][1]).toEqual([...(keep ? args : []), ...tail]);
  });
  it.each([
    ["--list-models"], ["--list-models", "private-filter"], ["--list-models=private-filter"],
    ["--help"], ["-h"], ["--version"], ["-v"], ["--export", "private-session"],
  ])("Pi inspection/exit config cannot spawn on either launch surface: %j", async (...args) => {
    const daemon = backendOpts("pi", { cliConfig: { args } });
    expect(() => selectSpawner("pi", daemon)).toThrow(/managed backend controls/);
    expect(daemon.spawnImpl).not.toHaveBeenCalled();
    const stderr = { write: vi.fn() };
    const foreground = launchOpts({ agents: [{ agentType: "pi", args }] }, { stderr });
    expect(await runAgentLaunch([], foreground)).toBe(1);
    expect(foreground.spawnImpl).not.toHaveBeenCalled();
    expect(stderr.write.mock.calls.flat().join()).not.toContain("private-");
  });
  it("explicit Pi inspection stays untouched and ordinary configured options still spawn", async () => {
    const args = ["--model", "chosen", "--thinking", "high"];
    const daemon = backendOpts("pi", { cliConfig: { args } });
    await selectSpawner("pi", daemon).wake(wake);
    expect(daemon.spawnImpl.mock.calls[0][1].slice(-5)).toEqual([...args, "-p"]);
    const foreground = launchOpts({ agents: [{ agentType: "pi", args }] });
    expect(await runAgentLaunch(["--", "--list-models", "explicit-filter"], foreground)).toBe(0);
    expect(foreground.spawnImpl.mock.calls[0][1]).toEqual([...args, "--list-models", "explicit-filter"]);
  });
  it("Windows foreground uses inherited mixed-case PATH and configured COMSPEC", async () => {
    const opts = launchOpts({ agents: [{ agentType: "pi", env: { comspec: "C:\\profile\\cmd.exe" } }] }, {
      platform: "win32", env: { pAtH: "C:\\bin", ComSpec: "C:\\base\\cmd.exe" },
    });
    expect(await runAgentLaunch([], opts)).toBe(0);
    expect(opts.spawnImpl.mock.calls[0][0]).toBe("C:\\profile\\cmd.exe");
    expect(opts.spawnImpl.mock.calls[0][1]).toEqual(["/d", "/s", "/c", "C:\\bin\\pi.cmd"]);
    expect(opts.spawnImpl.mock.calls[0][2].env).toEqual({ pAtH: "C:\\bin", comspec: "C:\\profile\\cmd.exe" });
  });
  it.each([...types, "opencode", "openclaw"])("%s absent/empty configuration preserves spawn behavior", async (type) => {
    const a = launchOpts({ agents: [{ agentType: type }] });
    const b = launchOpts({ agents: [{ agentType: type, args: [], env: {} }] });
    expect(await runAgentLaunch(["--", "--explicit"], a)).toBe(0);
    expect(await runAgentLaunch(["--", "--explicit"], b)).toBe(0);
    expect(a.spawnImpl.mock.calls).toEqual(b.spawnImpl.mock.calls);
  });
  it.each([...types, "opencode", "openclaw"])("%s uses effective type, literal config and untouched explicit tail", async (type) => {
    const config = { agents: [{ agentType: "offline", ...creds, args: ["--custom=space ; $HOME & |"], env: { PATH: "/profile", TOKEN: "${TOKEN}" } }] };
    const opts = launchOpts(config);
    const tail = ["--resume", "explicit-session", "--", "--model=positional"];
    expect(await runAgentLaunch(["--type", type, "--", ...tail], opts)).toBe(0);
    const [bin, argv, options] = opts.spawnImpl.mock.calls[0];
    expect(bin).toMatch(/^\/profile\//);
    expect(argv).toEqual([...config.agents[0].args, ...tail]);
    expect(options.env).toMatchObject({ TOKEN: "${TOKEN}", CHORUS_AGENT_PROFILE: UUID });
    expect(options.env.CHORUS_DAEMON_HEADLESS).toBeUndefined();
    if (type === "claude-code") expect(options.env.CLAUDECODE).toBeUndefined();
  });
  it.each([
    ["claude-code", ["--model", "old", "--effort=low"], ["--model=new", "--effort", "high"]],
    ["codex", ["-cmodel=old", "--config=model_reasoning_effort=low", "-c", "features.foo=true"], ["-mnew", "-c", "model_reasoning_effort=high"]],
    ["kiro", ["--model=old"], ["--model", "new"]],
    ["pi", ["--model", "old", "--thinking=low"], ["--model=new", "--thinking", "high"]],
    ["opencode", ["-mold"], ["--model=new"]],
    ["openclaw", ["--model=old", "--thinking=low"], ["agent", "--model=new", "--thinking=high"]],
  ])("%s filters only configured known duplicates at spawn", async (type, args, tail) => {
    const opts = launchOpts({ agents: [{ ...creds, agentType: type, args }] });
    expect(await runAgentLaunch(["--", ...tail], opts)).toBe(0);
    expect(opts.spawnImpl.mock.calls[0][1]).toEqual([...(type === "codex" ? ["-c", "features.foo=true"] : []), ...tail]);
  });
  it("validates using explicit type and fails without leaking values", async () => {
    const stderr = { write: vi.fn() };
    const opts = launchOpts({ agents: [{ agentType: "pi", args: ["--profile=secret"] }] }, { stderr });
    expect(await runAgentLaunch(["--type", "dsh"], opts)).toBe(1);
    expect(opts.spawnImpl).not.toHaveBeenCalled();
    expect(stderr.write.mock.calls.flat().join()).not.toContain("secret");
  });
  it("Windows PATH casing, safe shim args, and unsafe literal refusal", async () => {
    const profile = { agentType: "pi", args: ["--model=x"], env: { path: "C:\\profile", token: "literal & %VAR%" } };
    const opts = launchOpts({ agents: [profile] }, { platform: "win32", env: { Path: "C:\\base", TOKEN: "old", chorus_daemon_headless: "1" } });
    expect(await runAgentLaunch([], opts)).toBe(0);
    expect(opts.spawnImpl.mock.calls[0][1]).toEqual(["/d", "/s", "/c", "C:\\profile\\pi.cmd", "--model=x"]);
    expect(opts.spawnImpl.mock.calls[0][2].env).toEqual({ PATH: "C:\\profile", token: "literal & %VAR%" });
    profile.args = ["--model", "unsafe & configured"];
    expect(await runAgentLaunch(["--", "--model", "safe"], opts)).toBe(0);
    expect(opts.spawnImpl.mock.calls.at(-1)[1].slice(-2)).toEqual(["--model", "safe"]);
    profile.args = ["--custom=%TOKEN%&echo"];
    expect(await runAgentLaunch([], opts)).toBe(1);
    expect(opts.spawnImpl).toHaveBeenCalledTimes(2);
    profile.args = [];
    profile.env.path = "C:\\unsafe&dir";
    expect(await runAgentLaunch([], opts)).toBe(1);
    expect(opts.spawnImpl).toHaveBeenCalledTimes(2);
  });
});

describe("daemon runtime plumbing and restart/foreground reread", () => {
  const configDeps = (file) => ({ env: {}, loginPath: "/config", settingsPath: "/settings", readJson: (p) => p === "/config" ? file : null });
  function buildOpts(spawnImpl) {
    return { logger: silent, browseRoots: ["/work"], mcpClient: {}, lineage: {}, sseListener: {},
      spawnerOptions: backendOpts("pi", { spawnImpl }) };
  }
  it("Claude transcript probe uses the same configured home as the spawned child", async () => {
    const home = mkdtempSync(join(tmpdir(), "chorus-args-env-"));
    try {
      const path = transcriptPath(UUID, "/work", { env: { CLAUDE_CONFIG_DIR: home } });
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "");
      const opts = backendOpts("claude-code", { cliConfig: { env: { CLAUDE_CONFIG_DIR: home } } });
      const daemon = buildDaemon(creds, { ...buildOpts(opts.spawnImpl), agentType: "claude-code", cliConfig: opts.cliConfig, spawnerOptions: opts });
      const waker = [...daemon.connections[0].runtimeWakers.values()][0];
      const isNew = waker.isNewSessionFn(UUID, "/work");
      expect(isNew).toBe(false);
      await daemon.spawner.wake({ ...wake, isNew });
      expect(opts.spawnImpl.mock.calls[0][1]).toContain("--resume");
      expect(opts.spawnImpl.mock.calls[0][2].env.CLAUDE_CONFIG_DIR).toBe(home);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it.each(["claude_config_dir", "ClAuDe_CoNfIg_DiR", "home", "uSeRpRoFiLe"])("Windows Claude transcript probe and resume spawn agree on %s", async (key) => {
    const home = mkdtempSync(join(tmpdir(), "chorus-args-env-"));
    try {
      const configDir = key.toUpperCase() === "CLAUDE_CONFIG_DIR" ? home : join(home, ".claude");
      const path = transcriptPath(UUID, "/work", { platform: "win32", env: { CLAUDE_CONFIG_DIR: configDir } });
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "");
      const opts = backendOpts("claude-code", { platform: "win32", env: {}, cliConfig: { env: { [key]: home } } });
      const daemon = buildDaemon(creds, { ...buildOpts(opts.spawnImpl), env: {}, agentType: "claude-code", cliConfig: opts.cliConfig, spawnerOptions: opts });
      const waker = [...daemon.connections[0].runtimeWakers.values()][0];
      const isNew = waker.isNewSessionFn(UUID, "/work");
      expect(isNew).toBe(false);
      await daemon.spawner.wake({ ...wake, isNew });
      expect(opts.spawnImpl.mock.calls[0][1]).toContain("--resume");
      expect(opts.spawnImpl.mock.calls[0][2].env[key]).toBe(home);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it("flat runDaemon startup delivers config into its real spawner", async () => {
    const file = { args: ["--model=flat"], env: { TOKEN: "flat" } };
    const spawnImpl = fakeSpawn("pi");
    let daemon;
    const before = new Set(process.listeners("SIGINT")); const beforeTerm = new Set(process.listeners("SIGTERM"));
    try {
      const code = await runDaemon({ agent: "pi" }, {
        ...configDeps(file), resolve: () => creds, validate: async () => ({ uuid: UUID }), isTTY: false,
        log() {}, errLog() {}, waitForever: async () => {}, resolveClaudePath: () => "/fake",
        build: (c, d) => { daemon = buildDaemon(c, { ...d, ...buildOpts(spawnImpl) }); return { start: async () => {}, stop: async () => {} }; },
      });
      expect(code).toBe(0);
      await daemon.spawner.wake(wake);
      expect(spawnImpl.mock.calls[0][1]).toContain("--model=flat");
      expect(spawnImpl.mock.calls[0][2].env.TOKEN).toBe("flat");
    } finally {
      for (const listener of process.listeners("SIGINT")) if (!before.has(listener)) process.removeListener("SIGINT", listener);
      for (const listener of process.listeners("SIGTERM")) if (!beforeTerm.has(listener)) process.removeListener("SIGTERM", listener);
    }
  });
  it("multi-agent normal/dynamic Wakers retain startup snapshots; foreground rereads", async () => {
    const file = { url: creds.url, apiKey: creds.apiKey, agents: [
      { agentType: "pi", agentName: "one", args: ["--model=one"], env: { TOKEN: "one" }, cwds: ["/work/a"] },
      { agentType: "pi", agentName: "two", args: ["--model=two"], env: { TOKEN: "two" }, cwds: ["/work/b"] },
      { agentType: "offline", agentName: "off", args: ["--other"] },
    ] };
    const spawnImpl = fakeSpawn("pi");
    const configs = resolveAgentConfigs({}, configDeps(file));
    const multi = buildMultiAgentDaemon(configs, { ...buildOpts(spawnImpl), mcpClient: [{}, {}], lineage: [{}, {}], sseListener: [{}, {}] });
    expect(multi.agents).toHaveLength(2);
    file.agents[0].args[0] = "--model=updated"; file.agents[0].env.TOKEN = "updated";
    for (const { daemon } of multi.agents) {
      const connection = daemon.connections[0];
      connection.waker.markQueued({ entityType: "task", entityUuid: UUID, runtimeCwd: "/work/dynamic" }, "idea:a", {});
      const dynamic = connection.runtimeWakers.get("/work/dynamic");
      expect(dynamic.spawner).toBe(daemon.spawner);
      await daemon.spawner.wake(wake); await dynamic.spawner.wake({ ...wake, cwd: "/work/dynamic" });
    }
    expect(spawnImpl.mock.calls.map((call) => call[2].env.TOKEN)).toEqual(["one", "one", "two", "two"]);
    const foreground = launchOpts(file);
    expect(await runAgentLaunch(["--name", "one"], foreground)).toBe(0);
    expect(foreground.spawnImpl.mock.calls[0][1]).toEqual(["--model=updated"]);
    file.agents[0].args[0] = "--model=again";
    expect(await runAgentLaunch(["--name", "one"], foreground)).toBe(0);
    expect(foreground.spawnImpl.mock.calls[1][1]).toEqual(["--model=again"]);
    // A newly constructed daemon (restart) observes the new config too.
    const restarted = buildMultiAgentDaemon(resolveAgentConfigs({}, configDeps(file)), { ...buildOpts(spawnImpl), mcpClient: [{}, {}], lineage: [{}, {}], sseListener: [{}, {}] });
    await restarted.agents[0].daemon.spawner.wake(wake);
    expect(spawnImpl.mock.calls.at(-1)[1]).toContain("--model=again");
  });
});

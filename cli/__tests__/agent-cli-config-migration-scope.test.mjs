import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { appendAgentConfig } from "../login.mjs";
import { resolveAgentConfigs, resolveFlatAgentCliConfig } from "../daemon-config.mjs";
import { rejectSharedCliConfig, planAgentArgs } from "../agent-cli-config.mjs";
import { runAgentLaunch } from "../agent-launcher.mjs";
import { runDaemon } from "../daemon.mjs";

const freshAgent = { apiKey: "cho_new", agentName: "new", agentType: "pi" };
function diskConfig(file) {
  const dir = mkdtempSync(join(tmpdir(), "chorus-config-migration-"));
  const path = join(dir, "daemon.json");
  if (file) writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
  return {
    dir, path, read: () => JSON.parse(readFileSync(path, "utf8")),
    deps: { env: {}, loginPath: path, settingsPath: join(dir, "settings.json") },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
const flat = { url: "https://chorus.test", apiKey: "cho_old", agent: "codex", agentName: "old", cwds: ["/work"], yoloAckAt: "ack" };

describe("persisted flat customization migration", () => {
  it("atomically folds config, then real disk selection and a real child retain args/env", async () => {
    const config = { args: ["--model", "chosen", "--future=literal space & $VALUE"], env: { TOKEN: "literal ${TOKEN} & value" } };
    const disk = diskConfig({ ...flat, ...config });
    try {
      const original = readFileSync(disk.path, "utf8");
      const rename = vi.fn((from, to) => {
        expect(readFileSync(to, "utf8")).toBe(original); // live file unchanged until commit
        const staged = JSON.parse(readFileSync(from, "utf8"));
        expect(staged).not.toHaveProperty("args");
        expect(staged).not.toHaveProperty("env");
        expect(staged.agents[0]).toMatchObject(config);
        renameSync(from, to);
      });
      expect(appendAgentConfig(freshAgent, { path: disk.path, rename }).index).toBe(1);
      expect(rename).toHaveBeenCalledTimes(1);
      const persisted = disk.read();
      expect(persisted).not.toHaveProperty("args");
      expect(persisted).not.toHaveProperty("env");
      expect(persisted.yoloAckAt).toBe("ack");
      expect(persisted.agents[0]).toMatchObject({ ...config, agentType: "codex", apiKey: flat.apiKey });
      expect(() => rejectSharedCliConfig(persisted)).not.toThrow();
      expect(() => resolveFlatAgentCliConfig("codex", disk.deps)).not.toThrow();
      expect(resolveAgentConfigs({}, disk.deps)[0]).toMatchObject(config);
      expect(resolveAgentConfigs({}, disk.deps)[1]).toMatchObject({ args: [], env: {} });
      expect(existsSync(`${disk.path}.tmp`)).toBe(false);

      // No mocked readJson: runAgentLaunch selects from the actual migrated file.
      // A harmless Node fixture records what a genuinely spawned child receives.
      const fixture = join(disk.dir, "child.cjs");
      const output = join(disk.dir, "child.json");
      writeFileSync(fixture, 'require("node:fs").writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({args: process.argv.slice(2), token: process.env.TOKEN, key: process.env.CHORUS_API_KEY}));');
      const spawnImpl = vi.fn((_command, argv, opts) => spawn(process.execPath, [fixture, ...argv], opts));
      const launch = { ...disk.deps, env: { PATH: "/fake", CAPTURE_PATH: output }, platform: "linux", isFile: () => true, spawnImpl, stdout: { write() {} }, stderr: { write() {} } };
      expect(await runAgentLaunch(["--name", "old", "--", "exec", "prompt"], launch)).toBe(0);
      expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({ args: ["exec", ...config.args, "prompt"], token: config.env.TOKEN, key: flat.apiKey });
      const edited = disk.read();
      edited.agents[0].args = ["--model=updated"];
      edited.agents[0].env.TOKEN = "updated";
      writeFileSync(disk.path, JSON.stringify(edited));
      expect(await runAgentLaunch(["--name", "old", "--", "exec", "resume", "--last"], launch)).toBe(0);
      expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({ args: ["exec", "resume", "--model=updated", "--last"], token: "updated", key: flat.apiKey });
      expect(spawnImpl).toHaveBeenCalledTimes(2);
    } finally { disk.cleanup(); }
  });

  it.each([{ args: "private-invalid" }, { args: null }, { env: ["private-invalid"] }, { env: null }])("moves malformed fields by presence for field-level attribution: %j", (config) => {
    const disk = diskConfig({ ...flat, ...config });
    try {
      appendAgentConfig(freshAgent, { path: disk.path });
      expect(disk.read().agents[0]).toMatchObject(config);
      expect(disk.read()).not.toHaveProperty("args");
      expect(disk.read()).not.toHaveProperty("env");
      expect(() => resolveAgentConfigs({}, disk.deps)).toThrow(/Agent .*args|Agent .*env/);
      try { resolveAgentConfigs({}, disk.deps); } catch (error) {
        expect(error.message).toContain("agents[0]");
        expect(error.message).not.toContain("private-invalid");
      }
    } finally { disk.cleanup(); }
  });

  it.each(["args", "env"])("already-shared %s fails with exact file bytes unchanged", (field) => {
    const disk = diskConfig({ ...flat, agents: [freshAgent], [field]: null });
    try {
      const before = readFileSync(disk.path, "utf8");
      expect(() => appendAgentConfig({ apiKey: "another" }, { path: disk.path })).toThrow(/top-level args\/env/);
      expect(readFileSync(disk.path, "utf8")).toBe(before);
      expect(existsSync(`${disk.path}.tmp`)).toBe(false);
    } finally { disk.cleanup(); }
  });

  it.each([undefined, flat])("absent customization introduces no args/env fields", (file) => {
    const disk = diskConfig(file);
    try {
      appendAgentConfig(freshAgent, { path: disk.path });
      const expected = file ? { ...flat, agents: [{ apiKey: flat.apiKey, url: flat.url, agentType: flat.agent, cwds: flat.cwds, agentName: flat.agentName }, freshAgent] } : { agents: [freshAgent] };
      expect(readFileSync(disk.path, "utf8")).toBe(JSON.stringify(expected, null, 2) + "\n");
    } finally { disk.cleanup(); }
  });
  it("partial flat customization without a key is refused rather than made shared", () => {
    const disk = diskConfig({ args: ["--model=x"] });
    try {
      const before = readFileSync(disk.path, "utf8");
      expect(() => appendAgentConfig(freshAgent, { path: disk.path })).toThrow(/top-level args\/env/);
      expect(readFileSync(disk.path, "utf8")).toBe(before);
    } finally { disk.cleanup(); }
  });
  it("duplicate flat key does not commit a partial migration", () => {
    const disk = diskConfig({ ...flat, args: ["--model=x"], env: { TOKEN: "x" } });
    try {
      const before = readFileSync(disk.path, "utf8");
      expect(appendAgentConfig({ apiKey: flat.apiKey }, { path: disk.path }).ok).toBe(false);
      expect(readFileSync(disk.path, "utf8")).toBe(before);
    } finally { disk.cleanup(); }
  });
});

// start is an insertion index into the unchanged explicit token sequence.
const scopes = [
  ["codex", ["exec", "prompt"], 1],
  ["codex", ["exec", "resume", "session", "prompt"], 2],
  ["codex", ["resume", "--last"], 1],
  ["codex", ["--cd", "/work", "--oss", "exec", "prompt"], 4],
  ["codex", ["-C/work", "exec", "--json", "resume", "--last"], 4],
  ["codex", ["--cd=exec", "exec", "resume", "--last"], 3],
  ["codex", ["--model", "root", "exec", "prompt"], 3],
  ["codex", ["--config", "features.foo=true", "exec", "prompt"], 3],
  ["codex", ["--enable", "exec", "prompt"], 0],
  ["codex", ["--enable", "--model", "exec", "prompt"], 3],
  ["codex", ["exec", "--enable", "resume", "prompt"], 1],
  ["codex", ["exec", "--enable", "--model", "resume", "--last"], 4],
  ["codex", ["exec", "a prompt", "resume"], 1],
  ["codex", ["--future=exec", "exec", "prompt"], 2],
  ["codex", ["--future", "exec", "prompt"], 0],
  ["codex", ["--future", "--model", "exec"], 0],
  ["codex", ["exec", "--future", "resume"], 1],
  ["codex", ["--", "exec", "--model=new"], 0],
  ["codex", ["--cd", "--", "exec", "--model=new"], 0],
  ["codex", ["exec", "--", "resume", "--model=new"], 1],
  ["codex", ["exec", "--enable", "--", "resume", "--model=new"], 1],
  ["codex", ["review", "exec"], 0],
  ["codex", [], 0],
  ["kiro", ["chat", "prompt"], 1],
  ["kiro", ["--verbose", "chat", "prompt"], 2],
  ["kiro", ["--wrap", "chat"], 0],
  ["kiro", ["--wrap", "--model", "chat"], 3],
  ["kiro", [], 0],
  ["openclaw", ["agent", "--message", "prompt"], 1],
  ["openclaw", ["--profile", "work", "agent", "--message", "prompt"], 3],
  ["openclaw", ["--profile", "agent"], 0],
  ["openclaw", ["--profile", "--model", "agent"], 3],
  ["openclaw", ["--profile", "--", "agent", "--model=new"], 0],
  ["pi", ["exec", "prompt"], 0],
  ["pi", ["--append-system-prompt", "--", "exec", "--model=new"], 0],
];
function launchOpts(type, args, extra = {}) {
  return {
    env: { PATH: "/bin" }, platform: "linux", loginPath: "/config", settingsPath: "/settings",
    readJson: (path) => path === "/config" ? { agents: [{ agentType: type, args }] } : null,
    isFile: () => true, stdout: { write() {} }, stderr: { write: vi.fn() },
    spawnImpl: vi.fn(() => { const child = new EventEmitter(); queueMicrotask(() => child.emit("close", 0)); return child; }),
    ...extra,
  };
}
describe("known foreground command scopes at actual launch seam", () => {
  it.each(scopes)("%s %j inserts at %i without reordering explicit tokens", async (type, explicit, start) => {
    const configured = ["--model=chosen", "--future-extension=literal"];
    const expected = [...explicit.slice(0, start), ...configured, ...explicit.slice(start)];
    const plan = planAgentArgs(type, configured, explicit);
    expect(plan).toEqual({ args: expected, configuredArgs: configured });
    const opts = launchOpts(type, configured);
    expect(await runAgentLaunch(["--", ...explicit], opts)).toBe(0);
    expect(opts.spawnImpl.mock.calls[0][1]).toEqual(expected);
    expect(opts.spawnImpl.mock.calls[0][2].shell).toBe(false);
  });
  it.each([
    ["codex", ["--model=root", "exec", "--model=explicit"], ["--model=root", "exec", "--other=kept", "--model=explicit"]],
    ["codex", ["exec", "resume", "-mexplicit", "--last"], ["exec", "resume", "--other=kept", "-mexplicit", "--last"]],
    ["codex", ["-cmodel=explicit", "exec", "prompt"], ["-cmodel=explicit", "exec", "--other=kept", "prompt"]],
    ["kiro", ["chat", "--model", "explicit"], ["chat", "--other=kept", "--model", "explicit"]],
    ["openclaw", ["agent", "--model=explicit"], ["agent", "--other=kept", "--model=explicit"]],
  ])("%s recognizes only real overrides while retaining configured extensions", async (type, explicit, expected) => {
    const opts = launchOpts(type, ["--model=chosen", "--other=kept"]);
    expect(await runAgentLaunch(["--", ...explicit], opts)).toBe(0);
    expect(opts.spawnImpl.mock.calls[0][1]).toEqual(expected);
  });
  it.each(["codex", "kiro", "openclaw"])("%s Windows shim checks retained config, not an assumed prefix", async (type) => {
    const command = { codex: "exec", kiro: "chat", openclaw: "agent" }[type];
    const opts = launchOpts(type, ["--model", "unsafe & private"], { platform: "win32", env: { PATH: "C:\\bin" } });
    expect(await runAgentLaunch(["--", command, "prompt"], opts)).toBe(1);
    expect(opts.spawnImpl).not.toHaveBeenCalled();
    expect(opts.stderr.write.mock.calls.flat().join()).not.toContain("private");
    // Suppressed unsafe configuration is not sent to the shim and must not fail.
    expect(await runAgentLaunch(["--", command, "--model=safe"], opts)).toBe(0);
    expect(opts.spawnImpl.mock.calls[0][1].slice(-2)).toEqual([command, "--model=safe"]);
    const safe = launchOpts(type, ["--model=safe"], { platform: "win32", env: { PATH: "C:\\bin" } });
    expect(await runAgentLaunch(["--", command, "prompt"], safe)).toBe(0);
    expect(safe.spawnImpl.mock.calls[0][1].slice(-3)).toEqual([command, "--model=safe", "prompt"]);
  });
});

describe("flat config validation precedes preflight", () => {
  it.each([false, true])("rejects before credentials, prompts, network, setup or detach (detach=%s)", async (detach) => {
    const resolve = vi.fn(); const validate = vi.fn(); const prompt = vi.fn(); const prepareManagedDshConfig = vi.fn(); const startBackground = vi.fn();
    const errLog = vi.fn();
    expect(await runDaemon({ agent: "pi", detach }, {
      env: {}, loginPath: "/config", readJson: () => ({ args: "private-invalid" }), isTTY: true,
      resolve, validate, prompt, prepareManagedDshConfig, lifecycle: { startBackground }, log() {}, errLog,
    })).toBe(1);
    for (const seam of [resolve, validate, prompt, prepareManagedDshConfig, startBackground]) expect(seam).not.toHaveBeenCalled();
    expect(errLog.mock.calls.flat().join()).toContain("args must be an array");
    expect(errLog.mock.calls.flat().join()).not.toContain("private-invalid");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../init.mjs";
import { getAdapter, orderedSteps } from "../init/registry.mjs";
import { writeCodexEnvFile } from "../init/steps/credential-seed.mjs";

const roots = [];
const key = "cho_fresh_test_secret";
const url = "https://fresh.example";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "chorus restart integration "));
  roots.push(home);
  const codexHome = join(home, "codex home");
  const envPath = join(codexHome, ".env");
  const events = [];
  const lines = [];
  const snapshots = [];
  const appended = [];
  const io = { isTTY: true, log: (line) => lines.push(line), ask: vi.fn(async () => "yes") };
  const run = vi.fn((_cmd, args) => {
    events.push(args.join(" "));
    if (args.includes("--help")) return { ok: true, stdout: "Usage: codex app-server daemon restart [OPTIONS]", stderr: "" };
    if (args.includes("version")) return { ok: true, stdout: '{"status":"running","version":"0.160.0"}', stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  });
  const validate = vi.fn(async ({ apiKey }) => ({ uuid: apiKey === key ? "fresh-profile" : "other-profile", name: "Test agent" }));
  const appendAgent = vi.fn((agent) => {
    appended.push(agent);
    return { ok: true, index: appended.length - 1 };
  });
  const deps = {
    env: { HOME: home, CODEX_HOME: codexHome, PATH: "/unused-test-path", CHORUS_URL: "https://stale.example", CHORUS_API_KEY: "cho_stale_secret", CHORUS_AGENT_PROFILE: "stale-profile" },
    io,
    detectAgents: () => ["codex", "claude"].map((id) => ({ id, displayName: id, detected: false })),
    orderedSteps: () => orderedSteps().map((step) => ({
      ...step,
      run: async (ctx) => {
        events.push(`${step.id}:${ctx.agentId ?? "once"}`);
        snapshots.push({ step: step.id, agent: ctx.agentId, outcomes: ctx.priorOutcomes });
        return step.run(ctx);
      },
    })),
    getAdapter: (id) => id === "codex" ? getAdapter(id) : {
      id,
      readInstallState: () => ({ supported: true, pluginInstalled: false }),
      installPlugin: () => ({ stepId: "plugin-install", agentId: id, action: "installed", detail: "other agent configured" }),
    },
    ctxExtras: {
      run,
      validateCredentials: validate,
      appendAgent,
      promptFn: vi.fn(async (question) => question.includes("API key") ? "cho_other_test_secret" : "n"),
      resolveInstallCwds: async () => ({ cwds: [] }),
      readJson: () => ({ agents: appended }),
    },
  };
  return { deps, io, run, validate, appendAgent, events, snapshots, lines, codexHome, envPath };
}

async function install(test, extraArgs = []) {
  return runInit(["--agents", "codex", "--url", url, "--api-key", key, ...extraArgs], test.deps);
}

describe("real init orchestration with Codex restart and hermetic collaborators", () => {
  it("registers restart after plugin-install and before Chorus daemon setup", () => {
    expect(orderedSteps().map(({ id, order }) => [id, order])).toEqual([
      ["credential-seed", 10], ["plugin-install", 20], ["codex-restart", 25], ["daemon-setup", 30],
    ]);
  });

  it("passes flattened completed outcomes and restarts only after fresh env and real config writes", async () => {
    const test = fixture();
    const parentEnv = { ...test.deps.env };
    expect(await install(test)).toBe(0);
    const prior = test.snapshots.find(({ step }) => step === "codex-restart").outcomes;
    expect(prior).toHaveLength(2);
    expect(prior[0]).toMatchObject({ stepId: "credential-seed", codexEnvWritten: true });
    expect(prior[1]).toMatchObject({ stepId: "plugin-install", agentId: "codex", codexMcpWritten: true });
    expect(test.snapshots[0].outcomes).toEqual([]);
    expect(test.events).toEqual([
      "credential-seed:once", "plugin-install:codex",
      "plugin marketplace add Chorus-AIDLC/Chorus", "plugin add chorus@chorus-plugins --json",
      "codex-restart:codex", "app-server daemon restart --help", "app-server daemon version",
      "app-server daemon restart", "daemon-setup:once",
    ]);
    expect(readFileSync(test.envPath, "utf8")).toContain(key);
    const config = readFileSync(join(test.codexHome, "config.toml"), "utf8");
    expect(config).toContain(`${url}/api/mcp`);
    expect(config).toContain('bearer_token_env_var = "CHORUS_API_KEY"');
    expect(config).not.toContain(key);
    expect(test.run.mock.calls.at(-1)[2].env).toEqual({
      ...parentEnv, CHORUS_URL: url, CHORUS_API_KEY: key, CHORUS_AGENT_PROFILE: "fresh-profile",
    });
    expect(test.deps.env).toEqual(parentEnv);
    expect(test.validate).toHaveBeenCalledExactlyOnceWith({ url, apiKey: key });
    expect(test.io.ask).toHaveBeenCalledTimes(1);
    expect(test.lines.join("\n")).toContain("restart command succeeded");
    expect(test.lines.join("\n")).not.toContain(key);
  });

  it.each(["credential validation", "env write", "config write", "plugin install", "declined repoint"])("never probes/restarts after %s failure or deferral", async (mode) => {
    const test = fixture();
    if (mode === "credential validation") test.validate.mockRejectedValue(new Error("invalid test credential"));
    if (mode === "env write") test.deps.ctxExtras.writeCodexEnv = () => { throw new Error("cannot persist test env"); };
    if (mode === "config write") test.deps.ctxExtras.writeCodexMcpServer = () => { throw new Error(`cannot write ${key}`); };
    if (mode === "plugin install") test.run.mockReturnValue({ ok: false, stderr: "plugin failed" });
    if (mode === "declined repoint") {
      writeCodexEnvFile({ envPath: test.envPath, url: "https://old.example", apiKey: "cho_old_test_secret", agentProfile: "old-profile" });
    }
    const exitCode = await install(test);
    expect(exitCode).toBe(["credential validation", "plugin install"].includes(mode) ? 1 : 0);
    expect(test.run.mock.calls.every(([, args]) => args[0] === "plugin")).toBe(true);
    expect(test.io.ask).not.toHaveBeenCalled();
    const prior = test.snapshots.find(({ step }) => step === "codex-restart").outcomes;
    if (mode === "config write") {
      expect(prior[0].codexEnvWritten).toBe(true);
      expect(prior[1]).toMatchObject({ action: "installed", codexMcpWritten: false });
    }
    if (mode === "declined repoint") {
      expect(prior[0].codexEnvWritten).not.toBe(true);
      expect(readFileSync(test.envPath, "utf8")).toContain("cho_old_test_secret");
      expect(test.deps.ctxExtras.promptFn.mock.calls.some(([question]) => question.includes("currently configured"))).toBe(true);
    }
    expect(test.lines.join("\n")).toContain("restart deferred");
    expect(test.lines.join("\n")).not.toContain(key);
    expect(test.events.at(-1)).toBe("daemon-setup:once");
  });

  it("still permits restart after a successful env rewrite for an existing credential entry", async () => {
    const test = fixture();
    test.appendAgent.mockReturnValue({ ok: false, reason: "duplicate", index: 0 });
    expect(await install(test)).toBe(0);
    expect(test.lines.join("\n")).toContain("restart command succeeded");
  });

  it.each(["yes", "nonTTY", "headless", "no prompt"])("does not probe or prompt for unattended %s", async (mode) => {
    const test = fixture();
    const ask = test.io.ask;
    if (mode === "nonTTY") test.io.isTTY = false;
    if (mode === "headless") test.deps.env.CHORUS_DAEMON_HEADLESS = "1";
    if (mode === "no prompt") delete test.io.ask;
    expect(await install(test, mode === "yes" ? ["--yes"] : [])).toBe(0);
    expect(ask).not.toHaveBeenCalled();
    expect(test.run.mock.calls.every(([, args]) => args[0] === "plugin")).toBe(true);
    expect(test.lines.join("\n")).toContain("restart deferred");
  });

  it("never restarts a plugin-only invocation even if prior outcomes were supplied", async () => {
    const test = fixture();
    test.deps.parse = () => ({ agents: ["codex"], pluginOnly: true, url, apiKey: key });
    test.deps.resolveSelection = () => ({ selectedIds: ["codex"] });
    expect(await install(test)).toBe(0);
    expect(test.run.mock.calls.every(([, args]) => args[0] === "plugin")).toBe(true);
    expect(test.lines.join("\n")).not.toContain("Codex App Server restart");
  });

  it("isolates a failed Codex restart from other agents and later daemon setup", async () => {
    const test = fixture();
    const normalRun = test.run.getMockImplementation();
    test.run.mockImplementation((cmd, args, opts) => {
      if (args.join(" ") === "app-server daemon restart") {
        return { ok: false, stdout: key, stderr: key, error: key };
      }
      return normalRun(cmd, args, opts);
    });
    expect(await runInit(["--agents", "codex,claude", "--url", url, "--api-key", key], test.deps)).toBe(1);
    const text = test.lines.join("\n");
    expect(text).toContain("restart command failed or timed out");
    expect(text).toContain("claude: installed");
    expect(text).not.toContain(key);
    expect(test.events.at(-1)).toBe("daemon-setup:once");
    expect(test.validate).toHaveBeenCalledTimes(2);
    const completed = test.snapshots.find(({ step }) => step === "daemon-setup").outcomes;
    expect(completed.filter(({ stepId }) => stepId === "codex-restart")).toHaveLength(1);
    expect(completed.find(({ stepId }) => stepId === "codex-restart").agentId).toBe("codex");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexRestartStep } from "../init/steps/codex-restart.mjs";
import { writeCodexEnvFile } from "../init/steps/credential-seed.mjs";
import { runCommand } from "../init/run-command.mjs";

const roots = [];
const fresh = { CHORUS_URL: "https://fresh.example", CHORUS_API_KEY: "cho_fresh_secret", CHORUS_AGENT_PROFILE: "fresh-profile" };
const helpText = "Restart the local daemon\nUsage: codex app-server daemon restart [OPTIONS]\n";
const ok = (stdout = "") => ({ ok: true, code: 0, stdout, stderr: "" });
const priorOutcomes = () => [
  { stepId: "credential-seed", action: "seeded", codexEnvWritten: true },
  { stepId: "plugin-install", agentId: "codex", action: "installed", codexMcpWritten: true },
];

function fixture({ customHome = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), "chorus restart "));
  roots.push(home);
  const codexHome = join(home, customHome ? "codex home" : ".codex");
  const envPath = join(codexHome, ".env");
  writeCodexEnvFile({ envPath, url: fresh.CHORUS_URL, apiKey: fresh.CHORUS_API_KEY, agentProfile: fresh.CHORUS_AGENT_PROFILE });
  const ctx = {
    agentId: "codex",
    flags: {},
    env: {
      HOME: home, ...(customHome ? { CODEX_HOME: codexHome } : {}),
      CHORUS_URL: "https://stale.example", CHORUS_API_KEY: "cho_stale_secret", CHORUS_AGENT_PROFILE: "stale-profile",
      UNRELATED: "keep-me", PATH: "/unused-test-path",
    },
    priorOutcomes: priorOutcomes(),
    io: { isTTY: true, log: vi.fn(), ask: vi.fn(async () => "yes") },
    run: vi.fn((_cmd, args) => {
      if (args.includes("--help")) return ok(helpText);
      if (args.includes("version")) return ok(JSON.stringify({ status: "running", version: "0.160.0", backend: "local" }));
      return ok("restart output");
    }),
  };
  return { ctx, envPath, codexHome };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codex post-configuration restart", () => {
  it.each([true, false])("uses persisted credentials and resolved home with spaces (customHome=%s)", async (customHome) => {
    const { ctx, envPath, codexHome } = fixture({ customHome });
    const parent = { ...ctx.env };
    const globalEnv = { ...process.env };
    const originalFile = readFileSync(envPath, "utf8");
    const result = await codexRestartStep.run(ctx);
    expect(result.action).toBe("repaired");
    expect(result.detail).toContain("restart command succeeded");
    expect(result.detail).toContain("were not verified");
    expect(ctx.run.mock.calls.map(([cmd, args]) => [cmd, args])).toEqual([
      ["codex", ["app-server", "daemon", "restart", "--help"]],
      ["codex", ["app-server", "daemon", "version"]],
      ["codex", ["app-server", "daemon", "restart"]],
    ]);
    for (const [, , options] of ctx.run.mock.calls) {
      expect(options).toMatchObject({ env: { ...parent, ...fresh, CODEX_HOME: codexHome }, maxBuffer: 65536, killSignal: "SIGKILL" });
      expect(options.timeoutMs).toBeGreaterThan(0);
      expect(options.timeoutMs).toBeLessThanOrEqual(30000);
      expect(options.env).not.toBe(ctx.env);
    }
    expect(ctx.io.ask).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/interrupt other Codex sessions.*\[y\/N\]/));
    expect(ctx.env).toEqual(parent);
    expect(process.env).toEqual(globalEnv);
    expect(readFileSync(envPath, "utf8")).toBe(originalFile);
    expect(JSON.stringify(result)).not.toContain(fresh.CHORUS_API_KEY);
  });

  it("accepts a successful fresh env write on an otherwise idempotent seed/plugin rerun", async () => {
    const { ctx } = fixture();
    ctx.priorOutcomes.forEach((entry) => { entry.action = "skipped"; });
    expect((await codexRestartStep.run(ctx)).action).toBe("repaired");
    expect(ctx.run).toHaveBeenCalledTimes(3);
  });

  it("parses dotenv as data without shell evaluation or unrelated file overrides", async () => {
    const { ctx, envPath } = fixture();
    writeFileSync(envPath, 'export CHORUS_URL="https://quoted.example/#fragment"\nCHORUS_API_KEY=\'cho_$(not-a-command) # secret\'\nCHORUS_AGENT_PROFILE="profile with spaces"\nUNRELATED=replace\nHOME=/wrong\nCODEX_HOME=/wrong\n');
    expect((await codexRestartStep.run(ctx)).action).toBe("repaired");
    expect(ctx.run.mock.calls[2][2].env).toMatchObject({
      ...ctx.env, CHORUS_URL: "https://quoted.example/#fragment", CHORUS_API_KEY: "cho_$(not-a-command) # secret",
      CHORUS_AGENT_PROFILE: "profile with spaces",
    });
  });

  it.each([
    [],
    [{ stepId: "credential-seed", action: "seeded", codexEnvWritten: true }],
    [{ stepId: "plugin-install", agentId: "codex", action: "installed", codexMcpWritten: true }],
    [{ stepId: "credential-seed", action: "failed", codexEnvWritten: true }, priorOutcomes()[1]],
    [priorOutcomes()[0], { ...priorOutcomes()[1], action: "failed" }],
    [priorOutcomes()[0], { ...priorOutcomes()[1], codexMcpWritten: false }],
    [priorOutcomes()[0], { ...priorOutcomes()[1], codexMcpWritten: undefined }],
    [priorOutcomes()[0], { ...priorOutcomes()[1], agentId: "claude" }],
    [{ stepId: "credential-seed", action: "seeded", settingsEnvWritten: true }, priorOutcomes()[1]],
  ])("does not probe when prior configuration outcomes are insufficient: %j", async (...entries) => {
    const { ctx } = fixture();
    ctx.priorOutcomes = entries;
    expect((await codexRestartStep.run(ctx)).action).toBe("skipped");
    expect(ctx.run).not.toHaveBeenCalled();
    expect(ctx.io.ask).not.toHaveBeenCalled();
  });

  it.each(["claude", "kiro", "pi", "dsh", "openclaw", "opencode"])("does nothing for %s", async (agentId) => {
    const { ctx } = fixture();
    expect(await codexRestartStep.run({ ...ctx, agentId })).toEqual([]);
    expect(ctx.run).not.toHaveBeenCalled();
    expect(ctx.io.ask).not.toHaveBeenCalled();
  });

  it("does nothing for plugin-only refresh", async () => {
    const { ctx } = fixture();
    ctx.flags.pluginOnly = true;
    expect(await codexRestartStep.run(ctx)).toEqual([]);
    expect(ctx.run).not.toHaveBeenCalled();
  });

  it.each(["nonTTY", "yes", "headless", "no ask"])("defers without any prompt or probe for %s", async (mode) => {
    const { ctx } = fixture();
    const ask = ctx.io.ask;
    if (mode === "nonTTY") ctx.io.isTTY = false;
    if (mode === "yes") ctx.flags.yes = true;
    if (mode === "headless") ctx.env.CHORUS_DAEMON_HEADLESS = "1";
    if (mode === "no ask") delete ctx.io.ask;
    const result = await codexRestartStep.run(ctx);
    expect(result.action).toBe("skipped");
    expect(result.detail).toContain("--yes does not authorize restart");
    expect(ctx.run).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it.each(["", "n", "no", "true", "yes please", "y\nyes", undefined])("declines non-consent %j", async (answer) => {
    const { ctx } = fixture();
    ctx.io.ask.mockResolvedValue(answer);
    expect((await codexRestartStep.run(ctx)).action).toBe("skipped");
    expect(ctx.run).toHaveBeenCalledTimes(2);
  });

  it.each(["y", "YES", " Yes "])("accepts explicit consent %j", async (answer) => {
    const { ctx } = fixture();
    ctx.io.ask.mockResolvedValue(answer);
    expect((await codexRestartStep.run(ctx)).action).toBe("repaired");
    expect(ctx.run).toHaveBeenCalledTimes(3);
  });

  it("suppresses prompt errors and defers", async () => {
    const { ctx } = fixture();
    ctx.io.ask.mockRejectedValue(new Error(fresh.CHORUS_API_KEY));
    const result = await codexRestartStep.run(ctx);
    expect(result.detail).toContain("confirmation was unavailable");
    expect(JSON.stringify(result)).not.toContain(fresh.CHORUS_API_KEY);
    expect(ctx.run).toHaveBeenCalledTimes(2);
  });

  it.each(["missing", "directory", "empty", "missing key", "whitespace"])("defers for %s persisted env", async (mode) => {
    const { ctx, envPath } = fixture();
    if (mode === "missing" || mode === "directory") rmSync(envPath);
    if (mode === "directory") mkdirSync(envPath);
    if (mode === "empty") writeFileSync(envPath, "");
    if (mode === "missing key") writeFileSync(envPath, "CHORUS_URL=https://fresh.example\nCHORUS_AGENT_PROFILE=new");
    if (mode === "whitespace") writeFileSync(envPath, 'CHORUS_URL=https://fresh.example\nCHORUS_API_KEY=" "\nCHORUS_AGENT_PROFILE=new');
    const result = await codexRestartStep.run(ctx);
    expect(result.action).toBe("skipped");
    expect(ctx.run).not.toHaveBeenCalled();
    expect(ctx.io.ask).not.toHaveBeenCalled();
  });

  it.each(["stopped", "not_running", "starting", "RUNNING", "unknown", null, {}, [], { status: "running" }])("does not restart on status %j", async (status) => {
    const { ctx } = fixture();
    ctx.run.mockReturnValueOnce(ok(helpText)).mockReturnValueOnce(ok(JSON.stringify({ status })));
    const result = await codexRestartStep.run(ctx);
    expect(result.action).toBe("skipped");
    if (status === "stopped") expect(result.detail).toContain("no running daemon");
    expect(ctx.run).toHaveBeenCalledTimes(2);
    expect(ctx.io.ask).not.toHaveBeenCalled();
  });

  it.each(["not JSON", "null", "[]", '{}', '{"running":true}', '{"status":"running"}\nsecret'])("rejects unknown version output %j", async (stdout) => {
    const { ctx } = fixture();
    ctx.run.mockReturnValueOnce(ok(helpText)).mockReturnValueOnce(ok(stdout));
    expect((await codexRestartStep.run(ctx)).action).toBe("skipped");
    expect(ctx.io.ask).not.toHaveBeenCalled();
    expect(ctx.run).toHaveBeenCalledTimes(2);
  });

  it.each(["missing binary", "unsupported", "timeout", "thrown", "generic help", "too large"])("defers on %s probe without exposing output", async (failure) => {
    const { ctx } = fixture();
    if (failure === "thrown") ctx.run.mockImplementation(() => { throw new Error(fresh.CHORUS_API_KEY); });
    else if (failure === "generic help") ctx.run.mockReturnValue(ok(`Usage: codex ${fresh.CHORUS_API_KEY}`));
    else if (failure === "too large") ctx.run.mockReturnValue(ok(helpText + fresh.CHORUS_API_KEY.repeat(65536)));
    else ctx.run.mockReturnValue({ ok: false, error: `${failure} ${fresh.CHORUS_API_KEY}`, stdout: fresh.CHORUS_API_KEY, stderr: fresh.CHORUS_API_KEY });
    const result = await codexRestartStep.run(ctx);
    expect(result.action).toBe("skipped");
    expect(result.detail).toContain("restart support could not be confirmed");
    expect(result.detail).not.toContain(fresh.CHORUS_API_KEY);
    expect(ctx.io.ask).not.toHaveBeenCalled();
    expect(ctx.io.log).not.toHaveBeenCalled();
    expect(ctx.run).toHaveBeenCalledTimes(1);
  });

  it("requires a successful version command even if failure output claims running", async () => {
    const { ctx } = fixture();
    ctx.run.mockReturnValueOnce(ok(helpText)).mockReturnValueOnce({ ...ok('{"status":"running"}'), ok: false });
    expect((await codexRestartStep.run(ctx)).action).toBe("skipped");
    expect(ctx.io.ask).not.toHaveBeenCalled();
  });

  it.each(["error", "timeout", "thrown", "success"])("sanitizes restart %s and preserves configuration without follow-up probes", async (mode) => {
    const { ctx, envPath } = fixture();
    const saved = readFileSync(envPath, "utf8");
    ctx.run.mockReturnValueOnce(ok(helpText)).mockReturnValueOnce(ok('{"status":"running"}'));
    ctx.run.mockImplementation(() => {
      if (mode === "thrown") throw new Error(fresh.CHORUS_API_KEY);
      return { ok: mode === "success", stdout: fresh.CHORUS_API_KEY, stderr: fresh.CHORUS_API_KEY, error: `${mode} ${fresh.CHORUS_API_KEY}` };
    });
    const result = await codexRestartStep.run(ctx);
    expect(result.action).toBe(mode === "success" ? "repaired" : "failed");
    expect(JSON.stringify(result)).not.toContain(fresh.CHORUS_API_KEY);
    expect(ctx.io.log).not.toHaveBeenCalled();
    expect(ctx.run).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(ctx.run.mock.calls.map(([cmd, args]) => [cmd, args]))).not.toContain(fresh.CHORUS_API_KEY);
    expect(readFileSync(envPath, "utf8")).toBe(saved);
  });
});

describe("bounded installer runner", () => {
  it("bounds capture without invoking an agent CLI", () => {
    const result = runCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(1024 * 1024))"], { maxBuffer: 1024, timeoutMs: 5000, killSignal: "SIGKILL" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ENOBUFS/);
  });

  it("bounds command duration without invoking an agent CLI", () => {
    const result = runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { maxBuffer: 1024, timeoutMs: 50, killSignal: "SIGKILL" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ETIMEDOUT/);
  });
});

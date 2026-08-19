// cli/__tests__/init-plugin-install.test.mjs
// Covers the plugin-install step + per-agent install methods (spec:
// agent-plugin-install "Plugin-surface install via native remote marketplace" +
// "Idempotent, backed-up plugin installation"). Commands are faked (ctx.run);
// state readers are exercised against temp fixtures.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginInstallStep } from "../init/steps/plugin-install.mjs";
import {
  installClaude,
  installCodex,
  installOpencode,
  readCodexInstallState,
  readOpencodeInstallState,
  guided,
  GUIDED_MESSAGES,
} from "../init/install-methods.mjs";
import { OUTCOME_ACTIONS } from "../init/contracts.mjs";

const { INSTALLED, REPAIRED, SKIPPED, FAILED, UNSUPPORTED } = OUTCOME_ACTIONS;

/** A fake command runner recording calls; scripted results by index or matcher. */
function fakeRun(script = () => ({ ok: true, code: 0, stdout: "", stderr: "" })) {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return script(cmd, args, calls.length - 1);
  };
  run.calls = calls;
  return run;
}

function ctxFor(agentId, { state = {}, run, backup, env = {} } = {}) {
  return {
    agentId,
    env,
    run,
    backup,
    adapter: { id: agentId, installPlugin: () => {}, readInstallState: () => state },
  };
}

describe("pluginInstallStep", () => {
  it("delegates to the agent adapter's installPlugin", () => {
    const outcome = { stepId: "plugin-install", agentId: "x", action: INSTALLED, detail: "ok" };
    const res = pluginInstallStep.run({ agentId: "x", adapter: { id: "x", installPlugin: () => outcome } });
    expect(res).toBe(outcome);
    expect(pluginInstallStep.scope).toBe("per-agent");
  });
  it("returns FAILED (not throw) when no adapter is resolved", () => {
    expect(pluginInstallStep.run({ agentId: "x" }).action).toBe(FAILED);
  });
  it("isolates a throwing adapter as a FAILED outcome", () => {
    const res = pluginInstallStep.run({
      agentId: "x",
      adapter: { id: "x", installPlugin: () => { throw new Error("boom"); } },
    });
    expect(res.action).toBe(FAILED);
    expect(res.detail).toContain("boom");
  });
});

describe("installClaude (verified `claude plugin` CLI)", () => {
  it("skips when already installed", () => {
    const run = fakeRun();
    const res = installClaude(ctxFor("claude", { state: { pluginInstalled: true, version: "0.17.0" }, run }));
    expect(res.action).toBe(SKIPPED);
    expect(run.calls).toHaveLength(0);
  });
  it("registers marketplace + installs with -y when fresh", () => {
    const run = fakeRun();
    const res = installClaude(ctxFor("claude", { state: { marketplaceRegistered: false, pluginInstalled: false }, run }));
    expect(res.action).toBe(INSTALLED);
    expect(run.calls[0].args).toEqual(["plugin", "marketplace", "add", "https://github.com/Chorus-AIDLC/Chorus"]);
    expect(run.calls[1].args).toEqual(["plugin", "install", "chorus@chorus-plugins", "-y"]);
  });
  it("repairs (install only) when marketplace already registered", () => {
    const run = fakeRun();
    const res = installClaude(ctxFor("claude", { state: { marketplaceRegistered: true, pluginInstalled: false }, run }));
    expect(res.action).toBe(REPAIRED);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0].args).toContain("install");
  });
  it("fails when the install command fails", () => {
    const run = fakeRun(() => ({ ok: false, code: 1, stderr: "network down" }));
    const res = installClaude(ctxFor("claude", { state: { marketplaceRegistered: true }, run }));
    expect(res.action).toBe(FAILED);
    expect(res.detail).toContain("network down");
  });
});

describe("installCodex (verified codex-cli 0.146.1)", () => {
  it("backs up config.toml then runs marketplace add + plugin add --json", () => {
    const run = fakeRun();
    const backups = [];
    const res = installCodex(ctxFor("codex", { state: {}, run, backup: (p) => backups.push(p), env: { HOME: "/home/u" } }));
    expect(res.action).toBe(INSTALLED);
    expect(backups[0]).toBe("/home/u/.codex/config.toml");
    expect(run.calls[0].args).toEqual(["plugin", "marketplace", "add", "Chorus-AIDLC/Chorus"]);
    expect(run.calls[1].args).toEqual(["plugin", "add", "chorus@chorus-plugins", "--json"]);
  });
  it("skips when config.toml already has the plugin", () => {
    const run = fakeRun();
    const res = installCodex(ctxFor("codex", { state: { pluginInstalled: true }, run }));
    expect(res.action).toBe(SKIPPED);
    expect(run.calls).toHaveLength(0);
  });
});

describe("installOpencode (verified opencode 1.14.33)", () => {
  it("backs up opencode.json then runs `opencode plugin opencode-chorus`", () => {
    const run = fakeRun();
    const backups = [];
    const res = installOpencode(ctxFor("opencode", { state: {}, run, backup: (p) => backups.push(p), env: { HOME: "/home/u" } }));
    expect(res.action).toBe(INSTALLED);
    expect(backups[0]).toBe("/home/u/.config/opencode/opencode.json");
    expect(run.calls[0].args).toEqual(["plugin", "opencode-chorus", "-g"]);
  });
  it("skips when opencode.json already lists the plugin", () => {
    const run = fakeRun();
    const res = installOpencode(ctxFor("opencode", { state: { pluginInstalled: true }, run }));
    expect(res.action).toBe(SKIPPED);
  });
});

describe("guided (unverified agents)", () => {
  it("returns an UNSUPPORTED outcome with the guidance message", () => {
    for (const id of ["kiro", "openclaw", "pi", "dsh"]) {
      const res = guided(id, GUIDED_MESSAGES[id])();
      expect(res.action).toBe(UNSUPPORTED);
      expect(res.detail).toBe(GUIDED_MESSAGES[id]);
    }
  });
});

describe("state readers (temp fixtures)", () => {
  it("readCodexInstallState detects marketplace + plugin from config.toml", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-"));
    writeFileSync(
      join(dir, "config.toml"),
      '[marketplaces.chorus-plugins]\nsource = "x"\n\n[plugins."chorus@chorus-plugins"]\nenabled = true\n',
    );
    expect(readCodexInstallState({ env: { CODEX_HOME: dir } })).toEqual({
      marketplaceRegistered: true,
      pluginInstalled: true,
    });
    expect(readCodexInstallState({ env: { CODEX_HOME: join(dir, "nope") } })).toEqual({
      marketplaceRegistered: false,
      pluginInstalled: false,
    });
  });
  it("readOpencodeInstallState detects the plugin in opencode.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-"));
    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ plugin: ["opencode-chorus@1.0.0"] }));
    expect(readOpencodeInstallState({ env: { OPENCODE_CONFIG_DIR: dir } }).pluginInstalled).toBe(true);
    const empty = mkdtempSync(join(tmpdir(), "oc2-"));
    mkdirSync(empty, { recursive: true });
    expect(readOpencodeInstallState({ env: { OPENCODE_CONFIG_DIR: empty } }).pluginInstalled).toBe(false);
  });
});

// cli/__tests__/init-trae-adapter.test.mjs
// add-trae-cli-backend D5: the `chorus agents add` TRAE CLI adapter. It reuses the Codex
// plugin package + marketplace through the generalized Codex-family installer
// (installCodexFamily(CODEX_FAMILY.trae, ctx)), writes a KEYLESS [mcp_servers.chorus] block
// into $TRAE_HOME/traecli.toml, seeds $TRAE_HOME/.env, and shares the App Server restart step.
// Commands are faked via an injected ctx.run; file effects use temp homes.
import { afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_FAMILY } from "../codex-family.mjs";
import {
  installTrae,
  installCodexFamily,
  readTraeInstallState,
  readCodexFamilyInstallState,
} from "../init/install-methods.mjs";
import { AGENT_DESCRIPTORS, ADAPTERS } from "../init/adapters.mjs";
import { agentTypeForSelection, isWakeableAgentType } from "../init/agent-type-map.mjs";
import { writeCodexMcpServer, resolveFamilyConfigPath, resolveCodexConfigPath } from "../init/codex-mcp-config.mjs";
import { resolveCodexEnvPath } from "../init/steps/credential-seed.mjs";
import { codexRestartStep } from "../init/steps/codex-restart.mjs";
import { OUTCOME_ACTIONS } from "../init/contracts.mjs";

const { INSTALLED, REPAIRED, SKIPPED, FAILED, SEEDED } = OUTCOME_ACTIONS;
const TRAE = CODEX_FAMILY.trae;
const PLUGIN = "chorus@chorus-plugins";

const roots = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const tempHome = () => {
  const d = mkdtempSync(join(tmpdir(), "chorus-trae-adapter-"));
  roots.push(d);
  return d;
};

function fakeRun(script = () => ({ ok: true, code: 0, stdout: "", stderr: "" })) {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return script(cmd, args, calls.length - 1);
  };
  run.calls = calls;
  return run;
}

function ctxFor({ state = {}, run, backup, env = { HOME: "/home/u" }, flags, writeCodexMcpServer, resolveCredentials } = {}) {
  return {
    agentId: "trae",
    env,
    run,
    backup,
    flags,
    writeCodexMcpServer: writeCodexMcpServer ?? (() => {}),
    resolveCredentials: resolveCredentials ?? (() => ({ url: undefined })),
    adapter: { id: "trae", readInstallState: () => state },
  };
}

describe("TRAE descriptor + selection mapping", () => {
  it("registers a TRAE CLI descriptor whose binaries/config dir match CODEX_FAMILY.trae", () => {
    const d = AGENT_DESCRIPTORS.find((x) => x.id === "trae");
    expect(d).toMatchObject({ displayName: TRAE.displayName, binaries: ["traecli", "trae-cli"] });
    expect(d.binaries[0]).toBe(TRAE.binaries.posix[0]);
    expect(d.configDirs).toEqual([`$${TRAE.homeEnv}`, `~/${TRAE.homeDir}`]);
    expect(d.readState).toBe(readTraeInstallState);
    expect(d.install).toBe(installTrae);
  });
  it("is a supported (non-guided) adapter", () => {
    const a = ADAPTERS.find((x) => x.id === "trae");
    expect(a.readInstallState({ env: { HOME: "/nonexistent-trae" } }).supported).toBe(true);
  });
  it("maps the trae selection to the wakeable trae agentType", () => {
    expect(agentTypeForSelection("trae")).toBe("trae");
    expect(isWakeableAgentType(agentTypeForSelection("trae"))).toBe(true);
  });
});

describe("readTraeInstallState (traecli.toml)", () => {
  it("reads marketplace + plugin tables from $TRAE_HOME/traecli.toml", () => {
    const home = tempHome();
    writeFileSync(join(home, "traecli.toml"), `[marketplaces.chorus-plugins]\nsource_type = "git"\n\n[plugins."${PLUGIN}"]\nenabled = true\n`);
    expect(readTraeInstallState({ env: { TRAE_HOME: home } })).toEqual({ marketplaceRegistered: true, pluginInstalled: true });
    expect(readCodexFamilyInstallState(TRAE, { env: { TRAE_HOME: home } })).toEqual({ marketplaceRegistered: true, pluginInstalled: true });
  });
  it("falls back to ~/.trae and never reads ~/.codex", () => {
    const home = tempHome();
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "config.toml"), `[marketplaces.chorus-plugins]\n[plugins."${PLUGIN}"]\n`);
    expect(readTraeInstallState({ env: { HOME: home } })).toEqual({ marketplaceRegistered: false, pluginInstalled: false });
    mkdirSync(join(home, ".trae"));
    writeFileSync(join(home, ".trae", "traecli.toml"), `[marketplaces.chorus-plugins]\n`);
    expect(readTraeInstallState({ env: { HOME: home } })).toEqual({ marketplaceRegistered: true, pluginInstalled: false });
  });
});

describe("installTrae (verified traecli 0.209.1)", () => {
  it("fresh: backs up traecli.toml, adds the marketplace, installs with --yes via traecli", () => {
    const run = fakeRun();
    const backups = [];
    const mcp = [];
    const res = installTrae(ctxFor({
      run, backup: (p) => backups.push(p), env: { HOME: "/home/u", CHORUS_URL: "https://c.example" },
      writeCodexMcpServer: (a) => mcp.push(a),
    }));
    expect(res.action).toBe(INSTALLED);
    expect(res.agentId).toBe("trae");
    expect(backups).toEqual(["/home/u/.trae/traecli.toml"]);
    expect(run.calls.map((c) => [c.cmd, ...c.args])).toEqual([
      ["traecli", "plugin", "marketplace", "add", "Chorus-AIDLC/Chorus"],
      ["traecli", "plugin", "install", PLUGIN, "--yes"],
    ]);
    expect(mcp).toEqual([{ configPath: "/home/u/.trae/traecli.toml", url: "https://c.example" }]);
    expect(res.codexMcpWritten).toBe(true);
    expect(res.detail).toContain("via traecli plugin CLI");
  });
  it("honors TRAE_HOME and CHORUS_MARKETPLACE_SOURCE_TRAE (not the Codex override)", () => {
    const run = fakeRun();
    const backups = [];
    installTrae(ctxFor({
      run, backup: (p) => backups.push(p),
      env: { HOME: "/home/u", TRAE_HOME: "/x/trae", CHORUS_MARKETPLACE_SOURCE_TRAE: "/src/chorus", CHORUS_MARKETPLACE_SOURCE_CODEX: "/wrong" },
    }));
    expect(backups).toEqual(["/x/trae/traecli.toml"]);
    expect(run.calls[0].args).toEqual(["plugin", "marketplace", "add", "/src/chorus"]);
  });
  it("marketplace already registered: installs only → repaired", () => {
    const run = fakeRun();
    const res = installTrae(ctxFor({ state: { marketplaceRegistered: true }, run }));
    expect(res.action).toBe(REPAIRED);
    expect(run.calls.map((c) => c.args)).toEqual([["plugin", "install", PLUGIN, "--yes"]]);
  });
  it("re-run is idempotent: skipped, no CLI calls, MCP block re-normalized", () => {
    const run = fakeRun();
    const mcp = [];
    const res = installTrae(ctxFor({
      state: { marketplaceRegistered: true, pluginInstalled: true }, run,
      env: { HOME: "/home/u", CHORUS_URL: "https://c.example" }, writeCodexMcpServer: (a) => mcp.push(a),
    }));
    expect(res.action).toBe(SKIPPED);
    expect(res.detail).toContain("already installed (traecli.toml)");
    expect(run.calls).toHaveLength(0);
    expect(mcp).toHaveLength(1);
  });
  it("refresh: marketplace upgrade + reinstall → repaired", () => {
    const run = fakeRun();
    const backups = [];
    const res = installTrae(ctxFor({
      state: { marketplaceRegistered: true, pluginInstalled: true }, run, backup: (p) => backups.push(p),
      flags: { updateInstalled: true },
    }));
    expect(res.action).toBe(REPAIRED);
    expect(backups).toEqual(["/home/u/.trae/traecli.toml"]);
    expect(run.calls.map((c) => [c.cmd, ...c.args])).toEqual([
      ["traecli", "plugin", "marketplace", "upgrade", "chorus-plugins"],
      ["traecli", "plugin", "install", PLUGIN, "--yes"],
    ]);
  });
  it("refresh tolerates a local-path marketplace (traecli: not a Git marketplace) and still reinstalls", () => {
    const run = fakeRun((cmd, args) => args[2] === "upgrade"
      ? { ok: false, code: 1, stderr: "Error: marketplace `chorus-plugins` is not configured as a Git marketplace" }
      : { ok: true, code: 0 });
    const res = installTrae(ctxFor({ state: { marketplaceRegistered: true, pluginInstalled: true }, run, flags: { updateInstalled: true } }));
    expect(res.action).toBe(REPAIRED);
    expect(run.calls).toHaveLength(2);
  });
  it.each([
    ["marketplace add", {}, (args) => args[2] === "add", "traecli plugin marketplace add failed: offline"],
    ["plugin install", {}, (args) => args[1] === "install", "traecli plugin install failed: offline"],
    ["marketplace upgrade", { pluginInstalled: true, marketplaceRegistered: true }, (args) => args[2] === "upgrade", "traecli plugin marketplace upgrade failed: offline"],
  ])("reports a failed %s as failed", (_name, state, failing, detail) => {
    const run = fakeRun((cmd, args) => (failing(args) ? { ok: false, code: 1, stderr: "offline" } : { ok: true, code: 0 }));
    const mcp = [];
    const res = installTrae(ctxFor({ state, run, flags: { updateInstalled: true }, env: { HOME: "/h", CHORUS_URL: "https://c" }, writeCodexMcpServer: (a) => mcp.push(a) }));
    expect(res.action).toBe(FAILED);
    expect(res.detail).toBe(detail);
    expect(mcp).toHaveLength(0); // no MCP write after a failed CLI step
  });
  it("missing URL: installs the plugin but skips [mcp_servers.chorus] with a note", () => {
    const run = fakeRun();
    const mcp = [];
    const res = installTrae(ctxFor({ run, writeCodexMcpServer: (a) => mcp.push(a) }));
    expect(res.action).toBe(INSTALLED);
    expect(mcp).toHaveLength(0);
    expect(res.codexMcpWritten).toBe(false);
    expect(res.detail).toContain("skipped [mcp_servers.chorus]: no Chorus URL");
  });
  it("falls back to the credential resolver URL (daemon.json) when no flag/env URL", () => {
    const mcp = [];
    const res = installTrae(ctxFor({ run: fakeRun(), resolveCredentials: () => ({ url: "https://from-daemon" }), writeCodexMcpServer: (a) => mcp.push(a) }));
    expect(mcp[0].url).toBe("https://from-daemon");
    expect(res.codexMcpWritten).toBe(true);
  });
  it("pluginOnly (upgrade path) preserves connection settings", () => {
    const mcp = [];
    installTrae(ctxFor({
      state: { pluginInstalled: true, marketplaceRegistered: true }, run: fakeRun(),
      flags: { updateInstalled: true, pluginOnly: true, url: "https://c" }, writeCodexMcpServer: (a) => mcp.push(a),
    }));
    expect(mcp).toHaveLength(0);
  });
  it("installCodexFamily(codex) keeps the Codex command shape", () => {
    const run = fakeRun();
    installCodexFamily(CODEX_FAMILY.codex, { ...ctxFor({ run }), agentId: "codex" });
    expect(run.calls.map((c) => [c.cmd, ...c.args])).toEqual([
      ["codex", "plugin", "marketplace", "add", "Chorus-AIDLC/Chorus"],
      ["codex", "plugin", "add", PLUGIN, "--json"],
    ]);
  });
  it("Codex does NOT get the TRAE local-marketplace tolerance", () => {
    const run = fakeRun((cmd, args) => args[2] === "upgrade"
      ? { ok: false, code: 1, stderr: "Error: marketplace `chorus-plugins` is not configured as a Git marketplace" }
      : { ok: true, code: 0 });
    const res = installCodexFamily(CODEX_FAMILY.codex, {
      ...ctxFor({ state: { pluginInstalled: true, marketplaceRegistered: true }, run, flags: { updateInstalled: true } }), agentId: "codex",
    });
    expect(res.action).toBe(FAILED);
  });
});

describe("keyless [mcp_servers.chorus] in traecli.toml (real writer)", () => {
  it("resolves the profile config path", () => {
    expect(resolveFamilyConfigPath({ HOME: "/h" }, TRAE)).toBe("/h/.trae/traecli.toml");
    expect(resolveFamilyConfigPath({ HOME: "/h", TRAE_HOME: "/t" }, TRAE)).toBe("/t/traecli.toml");
    expect(resolveFamilyConfigPath({ HOME: "/h", CODEX_HOME: "/c" }, TRAE)).toBe("/h/.trae/traecli.toml");
    expect(resolveCodexConfigPath({ HOME: "/h" })).toBe("/h/.codex/config.toml");
  });
  it("installTrae writes url + bearer_token_env_var (no cho_ key), preserving traecli's own tables", () => {
    const home = tempHome();
    const cfg = join(home, "traecli.toml");
    const original = `model = "x"\n\n[marketplaces.chorus-plugins]\nsource_type = "git"\n\n[plugins."${PLUGIN}"]\nenabled = true\n`;
    writeFileSync(cfg, original);
    const res = installTrae({
      agentId: "trae",
      env: { TRAE_HOME: home, CHORUS_URL: "http://localhost:18637", CHORUS_API_KEY: "cho_SECRET_SHOULD_NOT_APPEAR" },
      run: fakeRun(),
      writeCodexMcpServer,
      adapter: { readInstallState: () => readTraeInstallState({ env: { TRAE_HOME: home } }) },
    });
    expect(res.action).toBe(SKIPPED);
    expect(res.codexMcpWritten).toBe(true);
    const text = readFileSync(cfg, "utf8");
    expect(text).toContain(original.trimEnd());
    expect(text).toContain('[mcp_servers.chorus]\nurl = "http://localhost:18637/api/mcp"\nbearer_token_env_var = "CHORUS_API_KEY"');
    expect(text).not.toMatch(/cho_/);
    expect(existsSync(join(home, ".codex"))).toBe(false);
  });
});

describe("TRAE credential .env path", () => {
  it("resolves $TRAE_HOME|~/.trae/.env (Codex default unchanged)", () => {
    expect(resolveCodexEnvPath({ HOME: "/h" }, TRAE)).toBe("/h/.trae/.env");
    expect(resolveCodexEnvPath({ HOME: "/h", TRAE_HOME: "/t" }, TRAE)).toBe("/t/.env");
    expect(resolveCodexEnvPath({ HOME: "/h" })).toBe("/h/.codex/.env");
  });
});

describe("App Server restart step for TRAE", () => {
  const priorFor = (agentId, envAgentId = agentId) => [
    { stepId: "credential-seed", action: SEEDED, codexEnvWritten: true, codexEnvAgentId: envAgentId },
    { stepId: "plugin-install", agentId, action: INSTALLED, codexMcpWritten: true },
  ];
  function restartCtx(home, { prior = priorFor("trae"), run, answer = "y" } = {}) {
    return {
      agentId: "trae",
      env: { HOME: home, TRAE_HOME: join(home, ".trae") },
      flags: {},
      priorOutcomes: prior,
      io: { isTTY: true, ask: async () => answer },
      run,
    };
  }
  const seedEnv = (home) => {
    mkdirSync(join(home, ".trae"), { recursive: true });
    writeFileSync(join(home, ".trae", ".env"), "CHORUS_URL=http://c\nCHORUS_API_KEY=cho_x\nCHORUS_AGENT_PROFILE=p\n");
  };

  it("restarts a running traecli daemon with the saved env and TRAE_HOME", async () => {
    const home = tempHome();
    seedEnv(home);
    const run = fakeRun((cmd, args) => {
      if (args.includes("--help")) return { ok: true, stdout: "Usage: traecli app-server daemon restart [OPTIONS]\n" };
      if (args.at(-1) === "version") return { ok: true, stdout: '{"status":"running","backend":"pid"}' };
      return { ok: true, stdout: '{"status":"restarted"}' };
    });
    const res = await codexRestartStep.run(restartCtx(home, { run }));
    expect(res).toMatchObject({ stepId: "codex-restart", agentId: "trae", action: REPAIRED });
    expect(res.detail).toContain("TRAE CLI App Server restart command succeeded");
    expect(run.calls.map((c) => [c.cmd, ...c.args])).toEqual([
      ["traecli", "app-server", "daemon", "restart", "--help"],
      ["traecli", "app-server", "daemon", "version"],
      ["traecli", "app-server", "daemon", "restart"],
    ]);
    expect(run.calls[2].opts.env).toMatchObject({ TRAE_HOME: join(home, ".trae"), CHORUS_API_KEY: "cho_x", CHORUS_AGENT_PROFILE: "p" });
  });
  it("defers (never starts a daemon) when traecli version fails because no daemon runs", async () => {
    const home = tempHome();
    seedEnv(home);
    const run = fakeRun((cmd, args) => args.includes("--help")
      ? { ok: true, stdout: "Usage: traecli app-server daemon restart [OPTIONS]\n" }
      : { ok: false, code: 1, stderr: "Error: failed to connect to …/app-server-control.sock" });
    const res = await codexRestartStep.run(restartCtx(home, { run }));
    expect(res.action).toBe(SKIPPED);
    expect(res.detail).toContain("TRAE CLI App Server restart deferred: daemon state could not be determined");
    expect(run.calls).toHaveLength(2);
  });
  it("does not treat a Codex .env write as TRAE's", async () => {
    const home = tempHome();
    seedEnv(home);
    const run = fakeRun();
    const prior = [
      { stepId: "credential-seed", action: SEEDED, codexEnvWritten: true, codexEnvAgentId: "codex" },
      { stepId: "plugin-install", agentId: "trae", action: INSTALLED, codexMcpWritten: true },
    ];
    const res = await codexRestartStep.run(restartCtx(home, { run, prior }));
    expect(res.action).toBe(SKIPPED);
    expect(res.detail).toContain("credential persistence or plugin configuration did not complete");
    expect(run.calls).toHaveLength(0);
  });
  it("ignores non-family agents", async () => {
    expect(await codexRestartStep.run({ agentId: "kiro" })).toEqual([]);
  });
});

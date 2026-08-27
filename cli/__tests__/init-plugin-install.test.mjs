// cli/__tests__/init-plugin-install.test.mjs
// Covers the plugin-install step + per-agent install methods (spec:
// agent-plugin-install "Plugin-surface install via native remote marketplace" +
// "Idempotent, backed-up plugin installation"). Commands are faked (ctx.run);
// state readers are exercised against temp fixtures.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { pluginInstallStep } from "../init/steps/plugin-install.mjs";
import {
  installClaude,
  installCodex,
  installOpencode,
  installDsh,
  installOpenclaw,
  readCodexInstallState,
  readOpencodeInstallState,
  readDshInstallState,
  readOpenclawInstallState,
  openclawMinHostVersion,
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

function ctxFor(agentId, { state = {}, run, backup, env = {}, io, flags, binaryOnPath, minHostVersion, writeCodexMcpServer } = {}) {
  return {
    agentId,
    env,
    run,
    backup,
    io,
    flags,
    binaryOnPath,
    minHostVersion,
    writeCodexMcpServer,
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

  it("writes [mcp_servers.chorus] after plugin add when a Chorus URL is available", () => {
    const run = fakeRun();
    const mcpCalls = [];
    const res = installCodex(
      ctxFor("codex", {
        state: {},
        run,
        env: { HOME: "/home/u" },
        flags: { url: "https://c.example" },
        writeCodexMcpServer: (a) => mcpCalls.push(a),
      }),
    );
    expect(res.action).toBe(INSTALLED);
    // Plugin surface first, then the MCP-block write.
    expect(run.calls[1].args).toEqual(["plugin", "add", "chorus@chorus-plugins", "--json"]);
    expect(mcpCalls).toHaveLength(1);
    expect(mcpCalls[0]).toEqual({ configPath: "/home/u/.codex/config.toml", url: "https://c.example" });
    expect(res.detail).toContain("[mcp_servers.chorus]");
    expect(res.detail).toContain('bearer_token_env_var="CHORUS_API_KEY"');
  });

  it("normalizes [mcp_servers.chorus] even on the already-installed path (idempotent repair)", () => {
    const run = fakeRun();
    const mcpCalls = [];
    const res = installCodex(
      ctxFor("codex", {
        state: { pluginInstalled: true },
        run,
        env: { HOME: "/home/u", CHORUS_URL: "https://c.example/api/mcp" },
        writeCodexMcpServer: (a) => mcpCalls.push(a),
      }),
    );
    expect(res.action).toBe(SKIPPED);
    expect(run.calls).toHaveLength(0); // no plugin re-install
    expect(mcpCalls).toHaveLength(1); // but the MCP block is still normalized
    expect(mcpCalls[0].url).toBe("https://c.example/api/mcp");
  });

  it("skips the MCP write (non-fatal) when no Chorus URL resolves", () => {
    const run = fakeRun();
    const mcpCalls = [];
    const res = installCodex(
      ctxFor("codex", { state: {}, run, env: { HOME: "/home/u" }, writeCodexMcpServer: (a) => mcpCalls.push(a) }),
    );
    expect(res.action).toBe(INSTALLED); // plugin still installed
    expect(mcpCalls).toHaveLength(0); // no URL → no MCP write
    expect(res.detail).toMatch(/skipped \[mcp_servers\.chorus\].*no Chorus URL/);
  });

  it("MCP-write failure is a non-fatal WARNING and never echoes the key", () => {
    const run = fakeRun();
    const res = installCodex(
      ctxFor("codex", {
        state: {},
        run,
        env: { HOME: "/home/u" },
        flags: { url: "https://c.example", apiKey: "cho_secret" },
        writeCodexMcpServer: () => {
          throw new Error("EACCES: permission denied");
        },
      }),
    );
    expect(res.action).toBe(INSTALLED); // plugin install still succeeded
    expect(res.detail).toMatch(/WARNING: could not write \[mcp_servers\.chorus\]/);
    expect(res.detail).not.toContain("cho_secret");
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

describe("installDsh (verified docs/CONNECT_DSH.md — dsh 0.1.0-rc.7)", () => {
  const CMD = ["plugin", "--profile", "work", "add", "@chorus-aidlc/chorus-dsh", "-w"];

  it("adds the bundle into the flag-supplied profile with the mandatory -w", async () => {
    const run = fakeRun();
    const res = await installDsh(ctxFor("dsh", {
      state: { pluginInstalled: false },
      run,
      binaryOnPath: () => true,
      flags: { dshProfile: "work" },
    }));
    expect(res.action).toBe(INSTALLED);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0].cmd).toBe("dsh");
    expect(run.calls[0].args).toEqual(CMD);
  });

  it("resolves the profile from CHORUS_DSH_PROFILE when no flag is given", async () => {
    const run = fakeRun();
    const res = await installDsh(ctxFor("dsh", {
      state: {},
      run,
      binaryOnPath: () => true,
      env: { CHORUS_DSH_PROFILE: "envprof" },
    }));
    expect(res.action).toBe(INSTALLED);
    expect(run.calls[0].args[2]).toBe("envprof");
  });

  it("prompts for the profile name on a TTY (no store enumeration)", async () => {
    const run = fakeRun();
    const asked = [];
    const io = { isTTY: true, ask: async (q) => { asked.push(q); return "picked"; } };
    const res = await installDsh(ctxFor("dsh", { state: {}, run, binaryOnPath: () => true, io }));
    expect(res.action).toBe(INSTALLED);
    expect(asked).toHaveLength(1);
    expect(run.calls[0].args).toEqual(["plugin", "--profile", "picked", "add", "@chorus-aidlc/chorus-dsh", "-w"]);
  });

  it("fails naming the pnpm prereq and runs NO command when pnpm is missing", async () => {
    // No injected binaryOnPath + empty PATH → the REAL PATH probe returns false.
    const run = fakeRun();
    const res = await installDsh(ctxFor("dsh", { run, env: { PATH: "" }, flags: { dshProfile: "work" } }));
    expect(res.action).toBe(FAILED);
    expect(res.detail).toMatch(/pnpm/);
    expect(run.calls).toHaveLength(0);
  });

  it("skips when the chosen profile already carries the bundle", async () => {
    const run = fakeRun();
    const res = await installDsh(ctxFor("dsh", {
      state: { pluginInstalled: true },
      run,
      binaryOnPath: () => true,
      flags: { dshProfile: "work" },
    }));
    expect(res.action).toBe(SKIPPED);
    expect(run.calls).toHaveLength(0);
  });

  it("fails (never guesses) in a non-TTY run with no explicit profile", async () => {
    const run = fakeRun();
    const res = await installDsh(ctxFor("dsh", {
      run,
      binaryOnPath: () => true,
      io: { isTTY: false },
    }));
    expect(res.action).toBe(FAILED);
    expect(res.detail).toMatch(/profile/);
    expect(run.calls).toHaveLength(0);
  });

  it("fails on a TTY that has no ask function and no explicit profile", async () => {
    const run = fakeRun();
    const res = await installDsh(ctxFor("dsh", { run, binaryOnPath: () => true, io: { isTTY: true } }));
    expect(res.action).toBe(FAILED);
    expect(run.calls).toHaveLength(0);
  });

  it("fails when the TTY prompt yields an empty name", async () => {
    const run = fakeRun();
    const res = await installDsh(ctxFor("dsh", {
      run,
      binaryOnPath: () => true,
      io: { isTTY: true, ask: async () => "   " },
    }));
    expect(res.action).toBe(FAILED);
    expect(run.calls).toHaveLength(0);
  });

  it("fails with the CLI error when `dsh plugin add` fails", async () => {
    const run = fakeRun(() => ({ ok: false, code: 1, stderr: "registry unreachable" }));
    const res = await installDsh(ctxFor("dsh", {
      state: {},
      run,
      binaryOnPath: () => true,
      flags: { dshProfile: "work" },
    }));
    expect(res.action).toBe(FAILED);
    expect(res.detail).toContain("registry unreachable");
  });
});

describe("installOpenclaw (verified openclaw-plugin README lines 32-35 + package.json openclaw.install)", () => {
  const INSTALL = ["plugins", "install", "npm:@chorus-aidlc/chorus-openclaw-plugin"];
  const ENABLE = ["plugins", "enable", "chorus-openclaw-plugin"];

  /** fakeRun that answers `openclaw --version` with `version`, else `rest`. */
  function openclawRun(version, rest = () => ({ ok: true, code: 0, stdout: "", stderr: "" })) {
    return fakeRun((cmd, args, idx) => {
      if (args.includes("--version")) return { ok: true, code: 0, stdout: `openclaw ${version}`, stderr: "" };
      return rest(cmd, args, idx);
    });
  }

  it("fresh host: runs install (npm: prefix) then enable and reports INSTALLED", () => {
    const run = openclawRun("2099.1.1"); // well above the floor
    const res = installOpenclaw(ctxFor("openclaw", { state: { pluginInstalled: false }, run }));
    expect(res.action).toBe(INSTALLED);
    expect(run.calls[0].args).toEqual(["--version"]);
    expect(run.calls[1].args).toEqual(INSTALL);
    expect(run.calls[1].args[2]).toMatch(/^npm:/); // npm: source prefix on install
    expect(run.calls[2].args).toEqual(ENABLE);
    expect(run.calls).toHaveLength(3);
  });

  it("host below minHostVersion: UNSUPPORTED naming the floor, NO install/enable", () => {
    // No injected minHostVersion → the real package's openclaw.install floor is read.
    const run = openclawRun("2026.3.0"); // below >=2026.4.27
    const res = installOpenclaw(ctxFor("openclaw", { state: { pluginInstalled: false }, run }));
    expect(res.action).toBe(UNSUPPORTED);
    expect(res.detail).toContain("2026.4.27");
    expect(res.detail).toContain("no install attempted");
    // Only the --version probe ran; nothing was installed or enabled.
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0].args).toEqual(["--version"]);
  });

  it("also refuses when the host is short a component below the floor", () => {
    const run = openclawRun("2026.4"); // 2026.4 < 2026.4.27
    const res = installOpenclaw(ctxFor("openclaw", { state: {}, run, minHostVersion: "2026.4.27" }));
    expect(res.action).toBe(UNSUPPORTED);
    expect(run.calls).toHaveLength(1);
  });

  it("installed-but-disabled: runs ONLY enable and reports REPAIRED", () => {
    const run = openclawRun("2026.4.27"); // exactly the floor → allowed
    const res = installOpenclaw(ctxFor("openclaw", {
      state: { pluginInstalled: true, pluginEnabled: false },
      run,
    }));
    expect(res.action).toBe(REPAIRED);
    expect(run.calls[0].args).toEqual(["--version"]);
    expect(run.calls[1].args).toEqual(ENABLE);
    expect(run.calls).toHaveLength(2); // no install command
  });

  it("installed + enabled: SKIPPED with no commands (not even a version probe)", () => {
    const run = openclawRun("2099.1.1");
    const res = installOpenclaw(ctxFor("openclaw", {
      state: { pluginInstalled: true, pluginEnabled: true },
      run,
    }));
    expect(res.action).toBe(SKIPPED);
    expect(run.calls).toHaveLength(0);
  });

  it("FAILED (no mutation) when the openclaw version cannot be determined", () => {
    const run = fakeRun(() => ({ ok: false, code: 127, stderr: "openclaw: command not found" }));
    const res = installOpenclaw(ctxFor("openclaw", { state: {}, run, minHostVersion: "2026.4.27" }));
    expect(res.action).toBe(FAILED);
    expect(res.detail).toContain("2026.4.27");
    expect(run.calls).toHaveLength(1); // version probe only
  });

  it("FAILED with the CLI error when `plugins install` fails", () => {
    const run = openclawRun("2099.1.1", (cmd, args) =>
      args.includes("install") ? { ok: false, code: 1, stderr: "registry 500" } : { ok: true });
    const res = installOpenclaw(ctxFor("openclaw", { state: { pluginInstalled: false }, run }));
    expect(res.action).toBe(FAILED);
    expect(res.detail).toContain("registry 500");
    expect(run.calls).toHaveLength(2); // version + failed install (no enable)
  });

  it("FAILED with the CLI error when `plugins enable` fails on a fresh install", () => {
    const run = openclawRun("2099.1.1", (cmd, args) =>
      args.includes("enable") ? { ok: false, code: 1, stderr: "enable boom" } : { ok: true });
    const res = installOpenclaw(ctxFor("openclaw", { state: { pluginInstalled: false }, run }));
    expect(res.action).toBe(FAILED);
    expect(res.detail).toContain("enable boom");
  });
});

describe("openclawMinHostVersion (read from the package, not hardcoded)", () => {
  it("reads openclaw.install.minHostVersion from the real plugin package.json", () => {
    // Prove it is READ from the block: compare against the on-disk package value.
    const pkgUrl = new URL("../../packages/openclaw-plugin/package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(new URL(pkgUrl), "utf8"));
    const declared = String(pkg.openclaw.install.minHostVersion).replace(/[^\d.]/g, "");
    expect(openclawMinHostVersion()).toBe(declared);
    expect(openclawMinHostVersion()).toBe("2026.4.27");
  });

  it("strips a leading range operator from an injected package block", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocpkg-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ openclaw: { install: { minHostVersion: ">=2099.1.1" } } }));
    expect(openclawMinHostVersion({ pkgUrl: pathToFileURL(join(dir, "package.json")) })).toBe("2099.1.1");
  });

  it("degrades to the documented fallback when the package.json is absent", () => {
    expect(openclawMinHostVersion({ pkgUrl: pathToFileURL(join(tmpdir(), "no-such-openclaw-pkg-xyz.json")) })).toBe("2026.4.27");
  });
});

describe("guided (unverified agents)", () => {
  it("returns an UNSUPPORTED outcome with the guidance message", () => {
    // dsh + openclaw + kiro are NO LONGER guided — they have real installers now.
    // Only pi remains guided (deferred).
    for (const id of ["pi"]) {
      const res = guided(id, GUIDED_MESSAGES[id])();
      expect(res.action).toBe(UNSUPPORTED);
      expect(res.detail).toBe(GUIDED_MESSAGES[id]);
    }
  });
  it("no longer carries stale dsh / openclaw / kiro guided messages", () => {
    expect(GUIDED_MESSAGES.dsh).toBeUndefined();
    expect(GUIDED_MESSAGES.openclaw).toBeUndefined();
    expect(GUIDED_MESSAGES.kiro).toBeUndefined();
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
  it("readDshInstallState detects the bundle in a profile's package.json (deps + devDeps)", () => {
    const dshHome = mkdtempSync(join(tmpdir(), "dsh-"));
    mkdirSync(join(dshHome, "work"), { recursive: true });
    writeFileSync(
      join(dshHome, "work", "package.json"),
      JSON.stringify({ dependencies: { "@chorus-aidlc/chorus-dsh": "^0.1.0" } }),
    );
    mkdirSync(join(dshHome, "devprof"), { recursive: true });
    writeFileSync(
      join(dshHome, "devprof", "package.json"),
      JSON.stringify({ devDependencies: { "@chorus-aidlc/chorus-dsh": "^0.1.0" } }),
    );
    mkdirSync(join(dshHome, "bare"), { recursive: true });
    writeFileSync(join(dshHome, "bare", "package.json"), JSON.stringify({ dependencies: { lodash: "^4" } }));

    expect(readDshInstallState({ env: { DSH_HOME: dshHome }, profile: "work" }).pluginInstalled).toBe(true);
    expect(readDshInstallState({ env: { DSH_HOME: dshHome }, profile: "devprof" }).pluginInstalled).toBe(true);
    expect(readDshInstallState({ env: { DSH_HOME: dshHome }, profile: "bare" }).pluginInstalled).toBe(false);
    // Missing profile dir → best-effort probe reports not-installed (no throw).
    expect(readDshInstallState({ env: { DSH_HOME: dshHome }, profile: "ghost" }).pluginInstalled).toBe(false);
  });
  it("readDshInstallState reports not-installed without a profile and falls back to ~/.dsh", () => {
    // No profile at all → cannot resolve which workspace, so not-installed.
    expect(readDshInstallState({ env: { DSH_HOME: "/nope" } }).pluginInstalled).toBe(false);
    // DSH_HOME + HOME unset → falls back to <home>/.dsh, which won't have the bundle.
    expect(readDshInstallState({ env: {}, profile: "work" }).pluginInstalled).toBe(false);
  });
  it("readOpenclawInstallState detects installed + enabled state from openclaw.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocw-"));
    writeFileSync(
      join(dir, "openclaw.json"),
      JSON.stringify({ plugins: { entries: { "chorus-openclaw-plugin": { enabled: true, config: {} } } } }),
    );
    expect(readOpenclawInstallState({ env: { OPENCLAW_CONFIG_DIR: dir } })).toEqual({
      marketplaceRegistered: false,
      pluginInstalled: true,
      pluginEnabled: true,
    });
  });
  it("readOpenclawInstallState detects installed-but-disabled (enabled false/absent)", () => {
    const disabledDir = mkdtempSync(join(tmpdir(), "ocw-dis-"));
    writeFileSync(
      join(disabledDir, "openclaw.json"),
      JSON.stringify({ plugins: { entries: { "chorus-openclaw-plugin": { enabled: false } } } }),
    );
    expect(readOpenclawInstallState({ env: { OPENCLAW_CONFIG_DIR: disabledDir } })).toMatchObject({
      pluginInstalled: true,
      pluginEnabled: false,
    });
    // `enabled` key absent ⇒ still installed, but not enabled.
    const bareDir = mkdtempSync(join(tmpdir(), "ocw-bare-"));
    writeFileSync(
      join(bareDir, "openclaw.json"),
      JSON.stringify({ plugins: { entries: { "chorus-openclaw-plugin": {} } } }),
    );
    expect(readOpenclawInstallState({ env: { OPENCLAW_CONFIG_DIR: bareDir } })).toMatchObject({
      pluginInstalled: true,
      pluginEnabled: false,
    });
  });
  it("readOpenclawInstallState reports not-installed when config/entry is absent", () => {
    const empty = mkdtempSync(join(tmpdir(), "ocw2-"));
    mkdirSync(empty, { recursive: true });
    // No openclaw.json at all.
    expect(readOpenclawInstallState({ env: { OPENCLAW_CONFIG_DIR: empty } })).toEqual({
      marketplaceRegistered: false,
      pluginInstalled: false,
      pluginEnabled: false,
    });
    // openclaw.json present but without the chorus entry.
    writeFileSync(join(empty, "openclaw.json"), JSON.stringify({ plugins: { entries: { other: { enabled: true } } } }));
    expect(readOpenclawInstallState({ env: { OPENCLAW_CONFIG_DIR: empty } }).pluginInstalled).toBe(false);
  });
});

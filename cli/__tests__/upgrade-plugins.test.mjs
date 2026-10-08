import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planPluginTargets, upgradePlugins } from "../upgrade-plugins.mjs";
import { CHORUS_PLUGIN_ID } from "../init/chorus-plugin-consts.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(config, version = "1.0.2") {
  // realpath the fixture home: on macOS tmpdir() sits under the /var -> /private/var
  // symlink, and upgradePlugins resolves its targets, so unresolved expectations
  // would never match.
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "chorus-plugin-test-")));
  roots.push(home);
  const write = (path, value) => {
    fs.mkdirSync(join(path, ".."), { recursive: true });
    fs.writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  };
  const configPath = join(home, ".chorus", "daemon.json");
  if (config !== undefined) write(configPath, config);
  const run = vi.fn((cmd, args) => ({
    ok: true,
    stdout: args.includes("--version") ? version : args.includes("--help") ? "--extension <source> --no-approve" : "",
  }));
  return { home, env: { HOME: home, PATH: "" }, configPath, run, write, resolveBinary: () => "/fake/host" };
}
function piSettings(f, packages, dir = join(f.home, ".pi", "agent")) {
  f.write(join(dir, "settings.json"), { theme: "my-theme", packages });
}

describe("Pi package isolation", () => {
  const chorus = "npm:@chorus-aidlc/chorus-pi";
  const adapter = "npm:pi-mcp-adapter@5.0.0";
  const mutations = (context) => context.run.mock.calls.filter(([, args]) => !args.includes("--help") && !args.includes("--version")).map(([, args]) => args);
  it.each(["0.99.0", "1.0.2"])("updates native Chorus alone on %s even with constrained adapters", async (version) => {
    const context = fixture({ agents: [{ agentType: "pi" }] }, version);
    piSettings(context, ["npm:pi-mcp-adapter@2.0.0", { source: chorus, extensions: ["safe.ts"] }, "npm:unrelated"]);
    const path = join(context.home, ".pi", "agent", "settings.json");
    const before = fs.readFileSync(path, "utf8");
    expect((await upgradePlugins(context))[0]).toMatchObject({ complete: true, detail: expect.stringContaining("global pi-mcp-adapter replaces native MCP") });
    expect(mutations(context)).toEqual([["update", "--extension", chorus, "--no-approve"]]);
    expect(fs.readFileSync(path, "utf8")).toBe(before);
  });
  it.each(["0.84.4", "0.87.1"])("retains verified adapter compatibility pin on %s", async (version) => {
    const context = fixture({ agents: [{ agentType: "pi" }] }, version);
    piSettings(context, [{ source: adapter }, chorus]);
    expect((await upgradePlugins(context))[0]).toMatchObject({ complete: true, detail: expect.stringContaining("compatibility pin") });
    expect(mutations(context)).toEqual([["update", "--extension", chorus, "--no-approve"]]);
  });
  it.each(["0.0.1", "^5.0.0", "latest", "beta"])("preserves unverified adapter constraint %s, continues other eligible components", async (version) => {
    const context = fixture({ agents: [{ agentType: "pi" }, { agentType: "claude-code" }] }, "0.87.1");
    piSettings(context, [{ source: `npm:pi-mcp-adapter@${version}` }, chorus]);
    const results = await upgradePlugins(context);
    expect(results[0]).toMatchObject({ complete: false, changed: true, detail: expect.stringContaining("constraints/source") });
    expect(results[1].complete).toBe(true);
    expect(mutations(context).filter((args) => args.includes(chorus))).toEqual([["update", "--extension", chorus, "--no-approve"]]);
  });
  it.each(["0.0.1", "^0.1.0", "beta"])("preserves Chorus constraint %s without claiming latest refreshed", async (version) => {
    const context = fixture({ agents: [{ agentType: "pi" }] });
    piSettings(context, [{ source: `${chorus}@${version}` }]);
    expect((await upgradePlugins(context))[0]).toMatchObject({ complete: false, changed: false, detail: expect.stringContaining("constraints preserved") });
    expect(mutations(context)).toEqual([]);
  });
  it("allows Chorus latest while preserving object/filter entry and source", async () => {
    const context = fixture({ agents: [{ agentType: "pi" }] });
    piSettings(context, [{ source: `${chorus}@latest`, extensions: ["safe.ts"] }]);
    expect((await upgradePlugins(context))[0].complete).toBe(true);
    expect(mutations(context)).toEqual([["update", "--extension", `${chorus}@latest`, "--no-approve"]]);
  });
  it.each([["0.87.1", [adapter, chorus]], ["1.0.2", [chorus]], ["unknown", [chorus]]])("installs only eligible exact identities for %s", async (version, sources) => {
    const context = fixture({ agents: [{ agentType: "pi" }] }, version);
    piSettings(context, ["npm:unrelated-pi-mcp-adapter", "npm:@chorus-aidlc/chorus-pi-extra"]);
    expect((await upgradePlugins(context))[0].complete).toBe(version !== "unknown");
    expect(mutations(context)).toEqual(sources.map((source) => ["install", source, "--no-approve"]));
  });
  it.each(["0.84.3", "2.0.0"])("runs no package commands for unsupported %s", async (version) => {
    const context = fixture({ agents: [{ agentType: "pi" }] }, version);
    expect((await upgradePlugins(context))[0]).toMatchObject({ complete: false, changed: false });
    expect(context.run.mock.calls.map(([, args]) => args)).toEqual([["--version"]]);
  });
  it("keeps current-project diagnostics while package commands use isolated scratch cwd", async () => {
    const context = fixture({ agents: [{ agentType: "pi" }] });
    context.cwd = join(context.home, "project");
    context.write(join(context.cwd, ".pi", "settings.json"), { packages: [{ source: adapter }], extensions: ["-builtin:mcp"] });
    const result = (await upgradePlugins(context))[0];
    expect(result.detail).toMatch(/current-project pi-mcp-adapter.*-builtin:mcp in current-project/);
    expect(context.run.mock.calls.every(([, , options]) => options.cwd !== context.cwd)).toBe(true);
  });
  it("reports unsupported targeting and actual failures without fallback or secrets", async () => {
    const context = fixture({ agents: [{ agentType: "pi" }] });
    piSettings(context, [chorus]);
    context.run.mockImplementation((cmd, args) => ({ ok: true, stdout: args.includes("--version") ? "1.0.2" : "--extensions" }));
    expect((await upgradePlugins(context))[0]).toMatchObject({ complete: false, changed: false });
    expect(mutations(context)).toEqual([]);
    context.run.mockImplementation((cmd, args) => args.includes("--extension") ? { ok: false, stderr: "cho_SECRET", code: 1 }
      : { ok: true, stdout: args.includes("--version") ? "1.0.2" : "--extension <source> --no-approve" });
    const result = (await upgradePlugins(context))[0];
    expect(result).toMatchObject({ complete: false, changed: true });
    expect(result.detail).not.toContain("cho_SECRET");
  });
  it("refuses malformed global settings without package commands", async () => {
    const context = fixture({ agents: [{ agentType: "pi" }] });
    context.write(join(context.home, ".pi", "agent", "settings.json"), "{bad");
    expect((await upgradePlugins(context))[0]).toMatchObject({ complete: false, changed: false, detail: expect.stringContaining("uncertain") });
    expect(mutations(context)).toEqual([]);
  });
});

describe("configured plugin synchronization", () => {
  it.each([undefined, {}, { agents: [] }])("missing/empty config is a successful no-op: %j", async (config) => {
    const f = fixture(config);
    expect((await upgradePlugins(f)).every((r) => r.complete)).toBe(true);
    expect(f.run).not.toHaveBeenCalled();
  });
  it.each(["{invalid JSON", "null", "[]", { agents: {} }, { agents: [{}], env: { HOME: "/wrong" } }])("malformed config fails without commands: %j", async (config) => {
    const f = fixture(config);
    expect((await upgradePlugins(f))[0].complete).toBe(false);
    expect(f.run).not.toHaveBeenCalled();
  });
  it("unreadable config is not treated as absent", async () => {
    const f = fixture();
    const result = await upgradePlugins({ ...f, fs: { readFileSync: () => { throw Object.assign(new Error(), { code: "EACCES" }); } } });
    expect(result[0].complete).toBe(false);
  });
  it("reports offline, unknown, missing and malformed rows without leaking names or keys", async () => {
    const f = fixture({ agents: [
      { agentType: "offline", name: "cho_SECRET", apiKey: "cho_KEY" },
      { agentType: "unknown" }, {}, null, { agentType: "__proto__" },
    ] });
    const r = await upgradePlugins(f);
    expect(r).toHaveLength(5);
    expect(r.every((x) => !x.complete)).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/cho_SECRET|cho_KEY/);
    expect(f.run).not.toHaveBeenCalled();
  });
  it("resolves distinct homes, shared homes and config overrides before state reads/commands", async () => {
    const f = fixture();
    const first = join(f.home, "a"), second = join(f.home, "b"), custom = join(f.home, "custom");
    f.write(f.configPath, { agents: [
      { agentType: "claude-code", env: { HOME: first }, daemonWake: false },
      { agentType: "claude", env: { HOME: first } },
      { agentType: "claude-code", env: { HOME: second } },
      { agentType: "claude-code", env: { CLAUDE_CONFIG_DIR: custom } },
    ] });
    f.write(join(first, ".claude", "plugins", "installed_plugins.json"), { plugins: { [CHORUS_PLUGIN_ID]: [{ version: "1.0" }] } });
    const results = await upgradePlugins(f);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.complete)).toBe(true);
    expect(results[0].target).toContain("agents[0], agents[1]");
    const updates = f.run.mock.calls.filter(([, a]) => a[1] === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0][2].env.HOME).toBe(first);
    expect(f.run.mock.calls.filter(([, a]) => a[1] === "install").map(([, , o]) => o.env.CLAUDE_CONFIG_DIR)).toEqual([join(second, ".claude"), custom]);
    for (const [, , opts] of f.run.mock.calls) {
      expect(opts.cwd).not.toBe(process.cwd());
      expect(fs.existsSync(opts.cwd)).toBe(false); // scratch is removed
      expect(opts.timeoutMs).toBe(120_000);
    }
  });
  it("deduplicates symlinked homes even when the destination does not yet exist", () => {
    const f = fixture(), other = join(f.home, "alias");
    fs.symlinkSync(f.home, other, "dir");
    const plan = planPluginTargets({ agents: [
      { agentType: "pi", env: { HOME: f.home } },
      { agentType: "pi", env: { HOME: other } },
    ] }, f);
    expect(plan.targets).toHaveLength(1);
  });
  it("uses legacy flat environment and explicit top-level type defaults", async () => {
    const f = fixture();
    const piDir = join(f.home, "legacy pi");
    f.write(f.configPath, { agent: "pi", env: { PI_CODING_AGENT_DIR: piDir, PATH: "/configured/bin" }, args: ["--model", "irrelevant"] });
    expect((await upgradePlugins(f))[0].complete).toBe(true);
    for (const [, args, opts] of f.run.mock.calls) {
      expect(opts.env.PI_CODING_AGENT_DIR).toBe(piDir);
      expect(opts.env.PATH).toBe("/configured/bin");
      expect(args).not.toContain("--model");
    }
    expect(planPluginTargets({ agent: "codex", agents: [{}] }, f).targets[0].type).toBe("codex");
  });
  it("finds a host available only in the configured PATH; missing hosts never mutate", async () => {
    const f = fixture(), bin = join(f.home, "bin");
    f.write(join(bin, "pi"), "# fixture executable\n");
    f.write(f.configPath, { agents: [
      { agentType: "pi", env: { PATH: bin } },
      { agentType: "codex", env: { PATH: join(f.home, "absent") } },
    ] });
    delete f.resolveBinary; // exercise real path lookup, fake command execution
    const r = await upgradePlugins(f);
    expect(r.map((x) => x.complete)).toEqual([true, false]);
    expect(f.run.mock.calls.every(([cmd]) => cmd === "pi")).toBe(true);
  });
  it("validates per-record environment before binary lookup and continues later records", async () => {
    const f = fixture({ agents: [
      { agentType: "pi", env: { HOME: 9 } },
      { agentType: "pi", env: { CHORUS_API_KEY: "cho_SECRET" } },
      { agentType: "pi" },
    ] });
    const r = await upgradePlugins(f);
    expect(r.map((x) => x.complete)).toEqual([false, false, true]);
    expect(JSON.stringify(r)).not.toContain("cho_SECRET");
  });
  it("normalizes Windows USERPROFILE/config-dir/PATH case and deduplicates destinations", () => {
    const f = fixture();
    const io = { realpathSync: (p) => p };
    const plan = planPluginTargets({ agents: [
      { agentType: "codex", env: { userprofile: "C:\\New Home", Path: "C:\\Tools", codex_home: "C:\\Shared" } },
      { agentType: "codex", env: { CODEX_HOME: "c:\\shared" } },
    ] }, { fs: io, platform: "win32", env: { HOME: "C:\\Old", USERPROFILE: "C:\\Old", PATH: "C:\\Old Tools" } });
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0].env).toMatchObject({ HOME: "C:\\New Home", USERPROFILE: "C:\\New Home", CODEX_HOME: "C:\\Shared", PATH: "C:\\Tools" });
    expect(plan.targets[0].env).not.toHaveProperty("codex_home");
  });
  it("reports Kiro source conflicts before any update", async () => {
    const f = fixture({ agents: [
      { agentType: "kiro", url: "https://first.example/api/mcp" },
      { agentType: "kiro", url: "https://second.example" },
    ] });
    const r = await upgradePlugins(f);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ complete: false, detail: expect.stringContaining("Conflicting") });
    expect(f.run).not.toHaveBeenCalled();
  });
  it("continues after a failed plugin without exposing raw diagnostics", async () => {
    const f = fixture({ agents: [{ agentType: "claude" }, { agentType: "pi" }] });
    const ok = f.run.getMockImplementation();
    f.run.mockImplementation((cmd, args) => cmd === "claude" ? { ok: false, stderr: "cho_SECRET" } : ok(cmd, args));
    const r = await upgradePlugins(f);
    expect(r.map((x) => x.complete)).toEqual([false, true]);
    expect(JSON.stringify(r)).not.toContain("cho_SECRET");
  });
  it("reports installer context, stderr and exit status with credential redaction", async () => {
    const f = fixture({ agents: [{ agentType: "claude" }, { agentType: "pi" }] });
    const ok = f.run.getMockImplementation();
    f.run.mockImplementation((cmd, args) => cmd === "claude"
      ? { ok: false, code: 17, stderr: "EACCES registry unavailable; token=private-secret" }
      : ok(cmd, args));
    const results = await upgradePlugins(f);
    expect(results[0].detail).toContain("claude plugin marketplace add failed");
    expect(results[0].detail).toContain("exit 17");
    expect(results[0].detail).toContain("EACCES");
    expect(JSON.stringify(results)).not.toContain("private-secret");
    expect(results[1].complete).toBe(true);
  });
  it("preserves Codex connection and unrelated config while refreshing only Chorus", async () => {
    const f = fixture({ agents: [{ agentType: "codex", url: "https://different.example" }] });
    const cfg = join(f.home, ".codex", "config.toml");
    const original = `[marketplaces.chorus-plugins]\n[plugins."${CHORUS_PLUGIN_ID}"]\n[mcp_servers.chorus]\nurl="https://original.example"\n[mcp_servers.other]\ntoken="secret"\n`;
    f.write(cfg, original);
    expect((await upgradePlugins(f))[0].complete).toBe(true);
    expect(fs.readFileSync(cfg, "utf8")).toBe(original);
    expect(f.run.mock.calls.map(([, a]) => a)).toEqual([
      ["plugin", "marketplace", "upgrade", "chorus-plugins"],
      ["plugin", "add", CHORUS_PLUGIN_ID, "--json"],
    ]);
    expect((await upgradePlugins(f))[0].complete).toBe(true);
    expect(fs.readdirSync(join(f.home, ".codex")).filter((path) => path.endsWith(".bak")))
      .toEqual(["config.toml.chorus-upgrade.bak"]);
    expect(fs.readFileSync(`${cfg}.chorus-upgrade.bak`, "utf8")).toBe(original);
  });
  it("refreshes Kiro assets from its instance preserving existing MCP credentials/settings", async () => {
    const f = fixture({ agents: [{ agentType: "kiro", url: "https://instance.example/api/mcp" }] });
    const mcp = join(f.home, ".kiro", "settings", "mcp.json");
    const original = { custom: true, mcpServers: { chorus: { url: "https://old", headers: { Authorization: "secret" } }, other: { token: "other-secret" } } };
    f.write(mcp, original);
    const fetch = vi.fn(async (url, opts) => {
      expect(opts.signal).toBeInstanceOf(AbortSignal);
      const body = url.endsWith("manifest.txt") ? "skill chorus\n"
        : url.endsWith("settings/mcp.json") ? JSON.stringify({ mcpServers: { chorus: { url: "placeholder" } } })
          : url.endsWith("chorus.json") ? '{"command":"__CHORUS_BIN__"}' : "# asset\n";
      return { ok: true, text: async () => body };
    });
    const r = await upgradePlugins({ ...f, fetch });
    expect(r[0]).toMatchObject({ complete: true, detail: expect.stringContaining("https://instance.example") });
    expect(JSON.parse(fs.readFileSync(mcp, "utf8"))).toEqual(original);
    expect(fs.existsSync(join(f.home, ".kiro", "skills", "chorus", "SKILL.md"))).toBe(true);
    expect(f.run).not.toHaveBeenCalled();
    expect(fetch.mock.calls.every(([url]) => url.startsWith("https://instance.example/kiro-plugin/"))).toBe(true);
  });
});

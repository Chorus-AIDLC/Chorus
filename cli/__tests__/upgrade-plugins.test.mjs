import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planPluginTargets, upgradePlugins } from "../upgrade-plugins.mjs";
import { CHORUS_PLUGIN_ID } from "../init/chorus-plugin-consts.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(config) {
  const home = fs.mkdtempSync(join(tmpdir(), "chorus-plugin-test-"));
  roots.push(home);
  const write = (path, value) => {
    fs.mkdirSync(join(path, ".."), { recursive: true });
    fs.writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  };
  const configPath = join(home, ".chorus", "daemon.json");
  if (config !== undefined) write(configPath, config);
  const run = vi.fn((cmd, args) => ({
    ok: true,
    stdout: args.includes("--help") ? "--extension <source> --no-approve" : "",
  }));
  return { home, env: { HOME: home, PATH: "" }, configPath, run, write, resolveBinary: () => "/fake/host" };
}
function piSettings(f, packages, dir = join(f.home, ".pi", "agent")) {
  f.write(join(dir, "settings.json"), { theme: "my-theme", packages });
}

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

describe("Pi package isolation", () => {
  it.each(["0.0.1", "^0.1.0", "beta"])("preserves string/object version constraint %s and continues eligible components/targets", async (version) => {
    const f = fixture({ agents: [{ agentType: "pi" }, { agentType: "claude-code" }] });
    const entries = [
      `npm:pi-mcp-adapter@${version}`,
      { source: "npm:@chorus-aidlc/chorus-pi", extensions: ["safe.ts"] },
      "npm:unrelated",
    ];
    piSettings(f, entries);
    const path = join(f.home, ".pi", "agent", "settings.json");
    const before = fs.readFileSync(path, "utf8");
    const r = await upgradePlugins(f);
    expect(r[0]).toMatchObject({ complete: false, changed: true, detail: expect.stringContaining("constraints") });
    expect(r[1].complete).toBe(true);
    expect(f.run.mock.calls.some(([cmd, args]) => cmd === "pi" && args.includes("npm:pi-mcp-adapter"))).toBe(false);
    expect(f.run.mock.calls.some(([cmd, args]) => cmd === "pi" && args.includes("npm:@chorus-aidlc/chorus-pi"))).toBe(true);
    expect(fs.readFileSync(path, "utf8")).toBe(before);
    piSettings(f, [
      { source: `npm:pi-mcp-adapter@${version}`, extensions: ["adapter.ts"] },
      "npm:@chorus-aidlc/chorus-pi@0.0.1",
    ]);
    f.run.mockClear();
    expect((await upgradePlugins(f))[0]).toMatchObject({ complete: false, changed: false });
    expect(f.run.mock.calls.filter(([cmd]) => cmd === "pi").every(([, args]) => args.includes("--help"))).toBe(true);
  });
  it("allows explicit latest tags without changing their settings", async () => {
    const f = fixture({ agents: [{ agentType: "pi" }] });
    piSettings(f, ["npm:pi-mcp-adapter@latest", { source: "npm:@chorus-aidlc/chorus-pi@latest" }]);
    expect((await upgradePlugins(f))[0].complete).toBe(true);
  });
  it("refreshes only the two named dependencies, preserving unrelated settings bytes", async () => {
    const f = fixture({ agents: [{ agentType: "pi" }] });
    piSettings(f, ["npm:pi-mcp-adapter", { source: "npm:@chorus-aidlc/chorus-pi" }, "npm:unrelated"]);
    const path = join(f.home, ".pi", "agent", "settings.json"), before = fs.readFileSync(path, "utf8");
    expect((await upgradePlugins(f))[0].complete).toBe(true);
    expect(f.run.mock.calls.map(([, a]) => a)).toEqual([
      ["update", "--help"],
      ["update", "--extension", "npm:pi-mcp-adapter", "--no-approve"],
      ["update", "--extension", "npm:@chorus-aidlc/chorus-pi", "--no-approve"],
    ]);
    expect(fs.readFileSync(path, "utf8")).toBe(before);
  });
  it("installs absent packages by exact name without all-extension updates", async () => {
    const f = fixture({ agents: [{ agentType: "pi" }] });
    piSettings(f, ["npm:unrelated-pi-mcp-adapter"]);
    expect((await upgradePlugins(f))[0].complete).toBe(true);
    expect(f.run.mock.calls.map(([, a]) => a)).toEqual([
      ["update", "--help"], ["install", "--help"],
      ["install", "npm:pi-mcp-adapter", "--no-approve"],
      ["install", "npm:@chorus-aidlc/chorus-pi", "--no-approve"],
    ]);
  });
  it("reports old Pi as incomplete; partial install does not imply all packages refreshed", async () => {
    const f = fixture({ agents: [{ agentType: "pi" }] });
    piSettings(f, ["npm:pi-mcp-adapter"]);
    f.run.mockImplementation((cmd, a) => ({ ok: true, stdout: a[0] === "update" ? "--extensions" : "--no-approve" }));
    expect((await upgradePlugins(f))[0]).toMatchObject({ complete: false, changed: true });
    expect(f.run.mock.calls.map(([, a]) => a)).toEqual([
      ["update", "--help"], ["install", "--help"],
      ["install", "npm:@chorus-aidlc/chorus-pi", "--no-approve"],
    ]);
  });
  it("does not mutate on unsupported noninteractive Pi install or malformed settings", async () => {
    const f = fixture({ agents: [{ agentType: "pi" }] });
    f.run.mockReturnValue({ ok: true, stdout: "old help" });
    expect((await upgradePlugins(f))[0].complete).toBe(false);
    expect(f.run.mock.calls.every(([, a]) => a.includes("--help"))).toBe(true);
    f.write(join(f.home, ".pi", "agent", "settings.json"), "{bad");
    f.run.mockClear();
    expect((await upgradePlugins(f))[0].complete).toBe(false);
    expect(f.run).not.toHaveBeenCalled();
  });
});

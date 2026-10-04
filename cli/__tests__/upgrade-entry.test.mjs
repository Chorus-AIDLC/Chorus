import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHORUS_PLUGIN_ID, CHORUS_MARKETPLACE_NAME } from "../init/chorus-plugin-consts.mjs";

const repo = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Actual entry-point execution in an isolated npm-global layout. The npm process
// is a fixture, so no registry, real installation, daemon or user home is touched.
function installation({ version = "1.0.0", latest = "1.1.0", failInstall = false, mismatch = false, removeModule = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "chorus-upgrade-entry-"));
  roots.push(root);
  const prefix = join(root, "npm prefix");
  const globalRoot = join(prefix, "lib", "node_modules");
  const pkg = join(globalRoot, "@chorus-aidlc", "chorus");
  const bin = join(prefix, "bin");
  const home = join(root, "home");
  const trace = join(root, "npm-calls.jsonl");
  mkdirSync(pkg, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(home, ".chorus"), { recursive: true });
  cpSync(join(repo, "chorus.mjs"), join(pkg, "chorus.mjs"));
  cpSync(join(repo, "cli"), join(pkg, "cli"), {
    recursive: true,
    filter: (path) => !path.includes("__tests__"),
  });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({
    name: "@chorus-aidlc/chorus", version, type: "module", bin: { chorus: "chorus.mjs" },
  }));
  symlinkSync(join(pkg, "chorus.mjs"), join(bin, "chorus"));
  // Registry installation metadata, as emitted by npm global installs.
  writeFileSync(join(globalRoot, ".package-lock.json"), JSON.stringify({
    lockfileVersion: 3,
    packages: { "node_modules/@chorus-aidlc/chorus": {
      version, resolved: `https://registry.npmjs.org/@chorus-aidlc/chorus/-/chorus-${version}.tgz`,
    } },
  }));
  const npmScript = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args) + "\\n");
if (args[0] === "root") console.log(${JSON.stringify(globalRoot)});
else if (args[0] === "prefix" || (args[0] === "config" && args.includes("prefix"))) console.log(${JSON.stringify(prefix)});
else if (args[0] === "ls") console.log(JSON.stringify({
  dependencies: { "@chorus-aidlc/chorus": {
    name: "@chorus-aidlc/chorus", version: ${JSON.stringify(version)}, path: ${JSON.stringify(pkg)},
    resolved: ${JSON.stringify(`https://registry.npmjs.org/@chorus-aidlc/chorus/-/chorus-${version}.tgz`)},
  } },
}));
else if (args[0] === "view") console.log(JSON.stringify(${JSON.stringify(latest)}));
else if (args[0] === "install") {
  if (${failInstall}) { console.error("fixture install failure"); process.exit(7); }
  const p = ${JSON.stringify(join(pkg, "package.json"))};
  const data = JSON.parse(fs.readFileSync(p, "utf8"));
  data.version = ${JSON.stringify(mismatch ? version : latest)};
  fs.writeFileSync(p, JSON.stringify(data));
  if (${removeModule}) fs.rmSync(${JSON.stringify(join(pkg, "cli", "upgrade-plugins.mjs"))});
} else { console.error("Unexpected fixture npm arguments"); process.exit(8); }
`;
  writeFileSync(join(bin, "npm"), npmScript, { mode: 0o755 });
  // An invalid daemon file proves that default mode doesn't resolve plugins.
  writeFileSync(join(home, ".chorus", "daemon.json"), "{invalid JSON");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(CHORUS_|npm_|NPM_|CODEX_HOME|CLAUDE_CONFIG_DIR|PI_CODING_AGENT_DIR|KIRO_DIR)/i.test(key)));
  Object.assign(env, { HOME: home, USERPROFILE: home, PATH: bin, NO_COLOR: "1" });
  return {
    root, home, pkg, prefix, bin,
    calls: () => {
      try { return readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); }
      catch { return []; }
    },
    run: (args) => {
      const r = spawnSync(process.execPath, [join(pkg, "chorus.mjs"), ...args], {
        env, cwd: root, encoding: "utf8", timeout: 15000,
      });
      return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? ""), error: r.error };
    },
  };
}

// POSIX executes the fake npm shebang; Windows command/layout behavior is covered
// separately with injected platform fixtures in the module suite.
describe.skipIf(process.platform === "win32")("upgrade actual CLI entry", () => {
  it.each(["upgrade", "update"])("%s help is a local fast path", (verb) => {
    const f = installation();
    const r = f.run([verb, "--help"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("--plugins");
    expect(f.calls()).toEqual([]);
  });

  it("rejects unknown arguments without external effects", () => {
    const f = installation();
    const r = f.run(["upgrade", "--unrecognized"]);
    expect(r.code).not.toBe(0);
    expect(f.calls()).toEqual([]);
  });

  it.each(["upgrade", "update"])("%s updates the isolated global prefix without reading daemon config", (verb) => {
    const f = installation();
    const r = f.run([verb]);
    expect(r.error).toBeUndefined();
    expect(r.code, r.out).toBe(0);
    expect(JSON.parse(readFileSync(join(f.pkg, "package.json"), "utf8")).version).toBe("1.1.0");
    const install = f.calls().filter((args) => args[0] === "install");
    expect(install).toHaveLength(1);
    expect(install[0].join(" ")).toContain(f.prefix);
    expect(r.out).toMatch(/restart|new session/i);
    expect(readFileSync(join(f.home, ".chorus", "daemon.json"), "utf8")).toBe("{invalid JSON");
  });

  it("checks requested plugins even when CLI is already current", () => {
    const f = installation({ version: "1.1.0" });
    const r = f.run(["update", "--plugins"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/config|JSON/i);
    expect(f.calls().some((args) => args[0] === "install")).toBe(false);
  });

  it("a current CLI and empty configuration is a successful no-op", () => {
    const f = installation({ version: "1.1.0" });
    writeFileSync(join(f.home, ".chorus", "daemon.json"), '{"agents":[]}');
    const r = f.run(["upgrade", "--plugins"]);
    expect(r.code, r.out).toBe(0);
    expect(f.calls().some((args) => args[0] === "install")).toBe(false);
  });

  it("does not downgrade a newer CLI", () => {
    const f = installation({ version: "1.2.0" });
    expect(f.run(["upgrade"]).code).toBe(0);
    expect(f.calls().some((args) => args[0] === "install")).toBe(false);
  });

  it("can continue plugin processing after npm replaces module files", () => {
    const f = installation({ removeModule: true });
    writeFileSync(join(f.home, ".chorus", "daemon.json"), '{"agents":[]}');
    const r = f.run(["upgrade", "--plugins"]);
    expect(r.code, r.out).toBe(0);
    expect(f.calls().some((args) => args[0] === "install")).toBe(true);
  });

  it("uses configured host homes, deduplicates shared destinations and redacts child output", () => {
    const f = installation({ version: "1.1.0" });
    const hostLog = join(f.root, "host-calls.jsonl");
    const profiles = [join(f.root, "profile A"), join(f.root, "profile B")];
    for (const dir of profiles) {
      mkdirSync(join(dir, "plugins"), { recursive: true });
      writeFileSync(join(dir, "plugins", "installed_plugins.json"), JSON.stringify({
        version: 2, plugins: { [CHORUS_PLUGIN_ID]: [{ scope: "user", version: "1.0.0" }] },
      }));
      writeFileSync(join(dir, "plugins", "known_marketplaces.json"), JSON.stringify({
        [CHORUS_MARKETPLACE_NAME]: { source: { source: "github", repo: "Chorus-AIDLC/Chorus" } },
      }));
    }
    writeFileSync(join(f.bin, "claude"), `#!${process.execPath}
require("node:fs").appendFileSync(${JSON.stringify(hostLog)}, JSON.stringify({
  args: process.argv.slice(2), home: process.env.CLAUDE_CONFIG_DIR,
}) + "\\n");
console.log("cho_fixture_secret_do_not_log");
`, { mode: 0o755 });
    writeFileSync(join(f.home, ".chorus", "daemon.json"), JSON.stringify({
      agents: [
        ...[profiles[0], profiles[1], profiles[0]].map((dir, i) => ({
          agentType: "claude-code", agentName: `Profile ${i}`,
          apiKey: "cho_fixture_secret_do_not_log",
          env: { CLAUDE_CONFIG_DIR: dir, PATH: f.bin }, daemonWake: false,
        })),
        { agentType: "offline", agentName: "Offline" },
      ],
    }));
    const r = f.run(["upgrade", "--plugins"]);
    expect(r.code).toBe(1); // offline is a documented incomplete target
    expect(r.out).not.toContain("cho_fixture_secret_do_not_log");
    const calls = readFileSync(hostLog, "utf8").trim().split("\n").map(JSON.parse);
    const updates = calls.filter((c) => c.args[0] === "plugin" && c.args[1] === "update");
    expect(updates).toHaveLength(2);
    expect(new Set(updates.map((c) => c.home))).toEqual(new Set(profiles));
    expect(updates.every((c) => c.args.includes(CHORUS_PLUGIN_ID))).toBe(true);
  });

  it("exits nonzero for pinned Pi sources even if its host commands would succeed", () => {
    const f = installation({ version: "1.1.0" });
    const piHome = join(f.home, ".pi", "agent");
    const hostLog = join(f.root, "pi-calls.jsonl");
    mkdirSync(piHome, { recursive: true });
    const settings = JSON.stringify({ packages: [
      "npm:pi-mcp-adapter@0.0.1",
      { source: "npm:@chorus-aidlc/chorus-pi@0.0.1", extensions: ["chorus.ts"] },
    ] });
    writeFileSync(join(piHome, "settings.json"), settings);
    writeFileSync(join(f.bin, "pi"), `#!${process.execPath}
require("node:fs").appendFileSync(${JSON.stringify(hostLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
console.log(process.argv.includes("--version") ? "1.0.2" : "--extension <source> --no-approve");
`, { mode: 0o755 });
    writeFileSync(join(f.home, ".chorus", "daemon.json"), '{"agents":[{"agentType":"pi"}]}');
    const r = f.run(["update", "--plugins"]);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/constraints.*preserved/i);
    expect(readFileSync(join(piHome, "settings.json"), "utf8")).toBe(settings);
    expect(readFileSync(hostLog, "utf8").trim().split("\n").map(JSON.parse)).toEqual([["--version"]]);
  });

  it.each([{ failInstall: true }, { mismatch: true }])("reports failed or unverifiable installation %j", (opts) => {
    const f = installation(opts);
    const r = f.run(["upgrade"]);
    expect(r.code).not.toBe(0);
    expect(f.calls().filter((args) => args[0] === "install")).toHaveLength(1);
  });
});

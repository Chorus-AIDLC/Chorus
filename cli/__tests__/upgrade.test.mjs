import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { PACKAGE, runUpgrade, upgradeCli } from "../upgrade.mjs";
import { commandForUpgrade, runUpgradeCommand } from "../upgrade-process.mjs";

const roots = [];
afterEach(() => { for (const p of roots.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });
function fixture({ version = "1.0.0", latest = "1.1.0", fail, mismatch, entry = {} } = {}) {
  const prefix = fs.mkdtempSync(join(tmpdir(), "chorus npm prefix "));
  roots.push(prefix);
  const root = join(prefix, "lib", "node_modules");
  const packageRoot = join(root, "@chorus-aidlc", "chorus");
  fs.mkdirSync(packageRoot, { recursive: true });
  const pkg = { name: PACKAGE, version };
  fs.writeFileSync(join(packageRoot, "package.json"), JSON.stringify(pkg));
  const run = vi.fn((cmd, args) => {
    expect(cmd).toBe("npm");
    if (args[0] === fail) return { ok: false, reason: "timed out", stdout: "cho_SECRET" };
    const result = {
      prefix, root, view: JSON.stringify(latest),
      ls: JSON.stringify({ dependencies: { [PACKAGE]: { ...pkg, path: packageRoot, ...entry } } }),
    }[args[0]];
    if (args[0] === "install") {
      if (!mismatch) fs.writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ ...pkg, version: latest }));
      return { ok: true, stdout: "" };
    }
    if (result === undefined) throw new Error("unexpected command");
    return { ok: true, stdout: result };
  });
  return { prefix, packageRoot, run, env: {}, log: vi.fn(), upgradePlugins: vi.fn(async () => []) };
}

describe("upgrade CLI", () => {
  it.each([["--help"], ["-h", "--plugins"], ["--invalid"], ["latest"], ["--help", "--invalid"]])("parses %j without IO", async (...args) => {
    const deps = { fs: new Proxy({}, { get: () => { throw new Error("IO"); } }), run: vi.fn(), log: vi.fn() };
    const flags = args.flat();
    expect(await runUpgrade(flags, deps)).toBe(flags.includes("--invalid") || flags.includes("latest") ? 1 : 0);
    expect(deps.run).not.toHaveBeenCalled();
  });
  it("upgrades the same prefix to a fixed version, verifies it, and isolates default mode", async () => {
    const f = fixture();
    expect(await runUpgrade([], f)).toBe(0);
    expect(f.run).toHaveBeenCalledWith("npm", ["install", "-g", `${PACKAGE}@1.1.0`, "--prefix", f.prefix, "--no-audit", "--no-fund", "--yes"], expect.objectContaining({ timeoutMs: 300_000 }));
    expect(f.upgradePlugins).not.toHaveBeenCalled();
    expect(f.log.mock.calls.flat().join(" ")).toContain("verified");
  });
  it.each(["1.1.0", "2.0.0"])("does not downgrade/current %s, still synchronizes plugins", async (version) => {
    const f = fixture({ version });
    expect(await runUpgrade(["--plugins"], f)).toBe(0);
    expect(f.run.mock.calls.some(([, a]) => a[0] === "install")).toBe(false);
    expect(f.upgradePlugins).toHaveBeenCalledOnce();
  });
  it.each(["prefix", "root", "ls", "view", "install"])("stops on npm %s failure/timeout without printing child secrets", async (fail) => {
    const f = fixture({ fail });
    expect(await runUpgrade(["--plugins"], f)).toBe(1);
    expect(f.upgradePlugins).not.toHaveBeenCalled();
    expect(f.log.mock.calls.flat().join(" ")).not.toContain("cho_SECRET");
  });
  it.each(["1.2.0-beta.1", "v1.2.0", "01.2.3", {}, ["1.2.0"]])("rejects unstable/malformed latest %j", async (latest) => {
    const f = fixture({ latest });
    expect((await upgradeCli(f)).complete).toBe(false);
    expect(f.run.mock.calls.some(([, a]) => a[0] === "install")).toBe(false);
  });
  it("fails post-install version mismatch before plugins", async () => {
    const f = fixture({ mismatch: true });
    expect(await runUpgrade(["--plugins"], f)).toBe(1);
    expect(f.upgradePlugins).not.toHaveBeenCalled();
    expect(f.log.mock.calls.flat().join(" ")).toContain("verification failed");
  });
  it("compares stable build metadata using SemVer precedence", async () => {
    const f = fixture({ version: "1.1.0+local", latest: "1.1.0+registry" });
    expect((await upgradeCli(f)).complete).toBe(true);
    expect(f.run.mock.calls.some(([, a]) => a[0] === "install")).toBe(false);
  });
  it("rejects a global root that disagrees with npm's prefix", async () => {
    const f = fixture();
    const run = f.run.getMockImplementation();
    f.run.mockImplementation((cmd, a, opts) => a[0] === "root" ? { ok: true, stdout: f.prefix } : run(cmd, a, opts));
    expect((await upgradeCli(f)).complete).toBe(false);
    expect(f.run.mock.calls.some(([, a]) => ["view", "install"].includes(a[0]))).toBe(false);
  });
  it.each([{ link: true }, { isLink: true }, { resolved: "file:/source" }, { _from: `${PACKAGE}@file:/source` }, { path: "/other-prefix" }, { version: "0.9.0" }])("rejects conflicting npm ownership %j", async (entry) => {
    const f = fixture({ entry });
    expect((await upgradeCli(f)).complete).toBe(false);
    expect(f.run.mock.calls.some(([, a]) => ["view", "install"].includes(a[0]))).toBe(false);
  });
  it("rejects a source checkout and an npm-linked package even when realpaths agree", async () => {
    const f = fixture();
    expect((await upgradeCli({ ...f, packageRoot: f.prefix })).complete).toBe(false);
    const source = join(f.prefix, "checkout");
    fs.renameSync(f.packageRoot, source);
    fs.symlinkSync(source, f.packageRoot, "dir");
    expect((await upgradeCli({ ...f, packageRoot: source })).complete).toBe(false);
  });
  it("surfaces incomplete plugin results and activation guidance", async () => {
    const f = fixture({ version: "1.1.0" });
    f.upgradePlugins.mockResolvedValue([{ target: "pi (agents[0])", complete: false, changed: true, detail: "unsupported targeted update" }]);
    expect(await runUpgrade(["--plugins"], f)).toBe(1);
    expect(f.log.mock.calls.flat().join(" ")).toContain("INCOMPLETE");
    expect(f.log.mock.calls.flat().join(" ")).toContain("Start new agent sessions");
  });
  it.each(["linux", "darwin"])("supports %s global layout without architecture-specific dependencies", async (platform) => {
    expect((await upgradeCli({ ...fixture(), platform })).complete).toBe(true);
  });
  it("supports Windows global layout with spaces and verifies the installed version", async () => {
    const prefix = "C:\\Program Files\\Node", root = win32.join(prefix, "node_modules");
    const packageRoot = win32.join(root, "@chorus-aidlc", "chorus");
    let version = "1.0.0";
    const io = {
      realpathSync: (p) => p, lstatSync: () => ({ isSymbolicLink: () => false }), existsSync: () => false,
      readFileSync: () => JSON.stringify({ name: PACKAGE, version }),
    };
    const run = vi.fn((cmd, a) => {
      if (a[0] === "install") version = "1.1.0";
      return { ok: true, stdout: {
        prefix, root, view: '"1.1.0"', install: "",
        ls: JSON.stringify({ dependencies: { [PACKAGE]: { name: PACKAGE, version, path: packageRoot } } }),
      }[a[0]] };
    });
    expect((await upgradeCli({ platform: "win32", packageRoot, fs: io, run })).complete).toBe(true);
    expect(run.mock.calls.find(([, a]) => a[0] === "install")[1]).toContain(prefix);
  });
});

describe("bounded platform process execution", () => {
  it("launches Windows npm.cmd through npm-cli.js and Node with literal paths/arguments", () => {
    const launch = commandForUpgrade("C:\\Program Files\\Node\\npm.cmd", ["install", "--prefix", "C:\\npm & data"], {
      platform: "win32", node: "C:\\Program Files\\Node\\node.exe", exists: () => true, realpath: (p) => p,
    });
    expect(launch).toEqual({
      command: "C:\\Program Files\\Node\\node.exe",
      args: ["C:\\Program Files\\Node\\node_modules\\npm\\bin\\npm-cli.js", "install", "--prefix", "C:\\npm & data"],
    });
  });
  it("supports native Windows executable and safely quoted host shim paths with spaces", () => {
    expect(commandForUpgrade("C:\\Program Files\\codex.exe", ["plugin", "add"], { platform: "win32" })).toEqual({ command: "C:\\Program Files\\codex.exe", args: ["plugin", "add"] });
    const r = commandForUpgrade("C:\\Program Files\\pi.cmd", ["update", "--extension", "npm:pi-mcp-adapter"], { platform: "win32", env: {} });
    expect(r.args.at(-1)).toBe('""C:\\Program Files\\pi.cmd" "update" "--extension" "npm:pi-mcp-adapter""');
    expect(r.windowsVerbatimArguments).toBe(true);
    expect(() => commandForUpgrade("C:\\pi.cmd", ["bad&command"], { platform: "win32" })).toThrow();
  });
  it("rejects unsupported npm shims, captures output, closes stdin and bounds child lifetime", () => {
    expect(() => commandForUpgrade("C:\\npm.cmd", [], { platform: "win32", exists: () => false })).toThrow();
    const spawnSync = vi.fn(() => ({ error: { code: "ETIMEDOUT" }, status: null, stderr: "cho_SECRET" }));
    const r = runUpgradeCommand("npm", ["view"], { resolveBinary: () => "/fake/npm", spawnSync, env: {}, timeoutMs: 1 });
    expect(r).toMatchObject({ ok: false, reason: "timed out" });
    expect(JSON.stringify(r)).not.toContain("cho_SECRET");
    expect(spawnSync).toHaveBeenCalledWith("/fake/npm", ["view"], expect.objectContaining({
      shell: false, timeout: 1, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"],
    }));
  });
  it("terminates an actual fixture subprocess on timeout", () => {
    const r = runUpgradeCommand("node", ["-e", "setInterval(()=>{},1000)"], {
      resolveBinary: () => process.execPath, timeoutMs: 50,
    });
    expect(r).toMatchObject({ ok: false, reason: "timed out" });
  });
});

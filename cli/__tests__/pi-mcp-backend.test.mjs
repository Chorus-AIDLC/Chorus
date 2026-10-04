import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePiVersion, probePiBackend, PI_CHORUS_SPEC } from "../init/pi-mcp-backend.mjs";
import { PI_LEGACY_ADAPTER_SPEC } from "../init/pi-compatibility.mjs";
import { installPi, readPiInstallState } from "../init/install-methods.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(version = "1.0.2", packages = []) {
  const root = mkdtempSync(join(tmpdir(), "pi-backend-"));
  roots.push(root);
  const env = { HOME: root, PI_CODING_AGENT_DIR: join(root, "agent"), PATH: "" };
  const cwd = join(root, "project");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(env.PI_CODING_AGENT_DIR);
  const path = join(env.PI_CODING_AGENT_DIR, "settings.json");
  writeFileSync(path, JSON.stringify({ theme: "keep", packages }));
  const run = vi.fn((cmd, args) => ({ ok: true, stdout: args[0] === "--version" ? version : "--extension <source> --no-approve" }));
  return { env, cwd, path, run, binaryOnPath: () => true };
}
const commands = (context) => context.run.mock.calls.filter(([, args]) => !args.includes("--version") && !args.includes("--help")).map(([, args]) => args);

describe("Pi backend decision", () => {
  it.each([
    ["0.84.4", "legacy", true], ["0.87.1", "legacy", true], ["0.98.9", "legacy", true],
    ["0.99.0", "native", true], ["0.99.2", "native", true], ["1.0.2", "native", true],
    ["1.10.12", "native", true], ["0.100.12", "native", true], ["pi v1.0.2+build.47\n", "native", true],
    ["0.84.3", "legacy", false], ["2.0.0", "native", false], ["10.12.34", "native", false],
  ])("classifies %s", (output, mode, supported) => {
    expect(parsePiVersion(output)).toMatchObject({ mode, supported });
  });
  it.each(["", "garbage", "0.99.0-beta.1", "v1.0.2-rc.0+build", "1.0", "1.0.2.3", "1.0.2 and 0.87.1", "01.0.2", null])("fails closed for %j", (output) => {
    expect(parsePiVersion(output)).toMatchObject({ mode: "unknown", supported: null, version: null });
  });
  it("bounds version probes and handles errors, failures and timeout without echoing output", () => {
    for (const run of [vi.fn(() => ({ ok: false, stdout: "1.0.2", error: "cho_SECRET" })), vi.fn(() => { throw new Error("timeout cho_SECRET"); })]) {
      const result = probePiBackend({ run, env: {} });
      expect(result.mode).toBe("unknown");
      expect(JSON.stringify(result)).not.toContain("cho_SECRET");
      expect(run.mock.calls[0][2].timeoutMs).toBe(5000);
    }
  });
});

describe("Pi install and state", () => {
  it.each(["0.99.0", "0.99.2", "1.0.2", "1.10.2"])("installs native Chorus only on %s", (version) => {
    const context = fixture(version);
    expect(installPi(context)).toMatchObject({ action: "installed", complete: true });
    expect(commands(context)).toEqual([["install", PI_CHORUS_SPEC, "--no-approve"]]);
  });
  it.each(["0.84.4", "0.87.1", "0.98.9"])("installs verified adapter before Chorus on %s", (version) => {
    const context = fixture(version);
    expect(installPi(context)).toMatchObject({ action: "installed", complete: true });
    expect(commands(context)).toEqual([["install", PI_LEGACY_ADAPTER_SPEC, "--no-approve"], ["install", PI_CHORUS_SPEC, "--no-approve"]]);
  });
  it.each(["0.84.3", "2.0.0", "3.1.0"])("refuses unsupported host %s without package commands", (version) => {
    const context = fixture(version);
    expect(installPi(context)).toMatchObject({ action: "unsupported", complete: false });
    expect(context.run.mock.calls.map(([, args]) => args)).toEqual([["--version"]]);
  });
  it.each(["", "nonsense", "1.0.2-beta"])("never touches adapter or claims completion for unknown %j", (version) => {
    const context = fixture(version, [PI_LEGACY_ADAPTER_SPEC]);
    expect(installPi(context)).toMatchObject({ action: "unsupported", complete: false, detail: expect.stringContaining("MCP setup incomplete") });
    expect(commands(context)).toEqual([["install", PI_CHORUS_SPEC, "--no-approve"]]);
  });
  it("missing binary executes nothing and gives conditional manual guidance", () => {
    const context = fixture();
    const result = installPi({ ...context, binaryOnPath: () => false });
    expect(result.action).toBe("unsupported");
    expect(result.detail).toMatch(/native Pi.*legacy Pi.*Unknown\/unsupported/);
    expect(context.run).not.toHaveBeenCalled();
  });
  it.each([[[]], [["npm:pi-mcp-adapter@99.0.0"]]])("skips native Chorus alone and ignores adapter constraints %j", (adapters) => {
    const context = fixture("1.0.2", [PI_CHORUS_SPEC, ...adapters]);
    expect(readPiInstallState(context)).toMatchObject({ chorusPiInstalled: true, pluginInstalled: true, adapterInstalled: !!adapters.length });
    expect(installPi(context)).toMatchObject({ action: "skipped", complete: true });
    expect(commands(context)).toEqual([]);
  });
  it("matches exact string/pinned/object npm identities, not near names or metadata", () => {
    const context = fixture("0.87.1", ["npm:pi-mcp-adapter-extra", "npm:other-pi-mcp-adapter", "git:pi-mcp-adapter", { source: "npm:other", note: PI_CHORUS_SPEC }]);
    expect(readPiInstallState(context)).toMatchObject({ chorusPiInstalled: false, adapterInstalled: false, pluginInstalled: false });
    writeFileSync(context.path, JSON.stringify({ packages: [{ source: PI_CHORUS_SPEC + "@0.21.0", extensions: ["main.ts"] }, { source: PI_LEGACY_ADAPTER_SPEC }] }));
    expect(readPiInstallState(context)).toMatchObject({ chorusPiInstalled: true, adapterInstalled: true, adapterCompatible: true, pluginInstalled: true });
    const unknown = { ...context, backend: parsePiVersion("") };
    expect(readPiInstallState(unknown).pluginInstalled).toBe(false);
  });
  it.each([[[PI_LEGACY_ADAPTER_SPEC]], [[PI_CHORUS_SPEC]]])("repairs only the missing legacy component %j", (packages) => {
    const context = fixture("0.87.1", packages);
    expect(installPi(context)).toMatchObject({ action: "repaired", complete: true });
    expect(commands(context)).toEqual([["install", packages[0] === PI_CHORUS_SPEC ? PI_LEGACY_ADAPTER_SPEC : PI_CHORUS_SPEC, "--no-approve"]]);
  });
  it("targeted init update keeps the adapter policy pin and all settings bytes", () => {
    const context = fixture("0.87.1", [{ source: PI_LEGACY_ADAPTER_SPEC, extensions: ["index.ts"] }, { source: PI_CHORUS_SPEC, skills: ["foo"] }, "npm:unrelated"]);
    const before = readFileSync(context.path, "utf8");
    expect(installPi({ ...context, flags: { updateInstalled: true } })).toMatchObject({ action: "repaired", complete: true });
    expect(commands(context)).toEqual([["update", "--extension", PI_CHORUS_SPEC, "--no-approve"]]);
    expect(readFileSync(context.path, "utf8")).toBe(before);
  });
  it.each(["npm:pi-mcp-adapter", "npm:pi-mcp-adapter@latest", "npm:pi-mcp-adapter@^5.0.0", "npm:pi-mcp-adapter@4.0.0"])("diagnoses unverified legacy source %s without changing it", (source) => {
    const context = fixture("0.87.1", [{ source }]);
    const before = readFileSync(context.path, "utf8");
    expect(installPi(context)).toMatchObject({ complete: false, detail: expect.stringContaining("constraints/source") });
    expect(commands(context)).toEqual([["install", PI_CHORUS_SPEC, "--no-approve"]]);
    expect(readFileSync(context.path, "utf8")).toBe(before);
  });
  it("diagnoses global/current-project adapter and disable filters even on skip", () => {
    const context = fixture("1.0.2", [PI_CHORUS_SPEC]);
    const settings = JSON.stringify({ packages: [PI_CHORUS_SPEC, { source: PI_LEGACY_ADAPTER_SPEC }], extensions: ["-builtin:mcp"] });
    writeFileSync(context.path, settings);
    const local = join(context.cwd, ".pi", "settings.json");
    writeFileSync(local, settings);
    const result = installPi(context);
    expect(result.action).toBe("skipped");
    expect(result.warnings).toHaveLength(4);
    expect(result.detail).toMatch(/global.*replaces native MCP.*global.*disabled.*current-project.*replaces native MCP.*current-project.*disabled/);
    expect(readFileSync(local, "utf8")).toBe(settings);
    expect(readFileSync(context.path, "utf8")).toBe(settings);
    expect(commands(context)).toEqual([]);
  });
  it.each(["{bad cho_SECRET", "null", "[]", '{"packages":{}}', '{"packages":[{}]}', '{"extensions":{}}'])("refuses unsafe global settings %s without package commands", (contents) => {
    const context = fixture();
    writeFileSync(context.path, contents);
    expect(installPi(context)).toMatchObject({ complete: false, detail: expect.stringContaining("uncertain") });
    expect(commands(context)).toEqual([]);
    expect(installPi(context).detail).not.toContain("cho_SECRET");
    expect(readFileSync(context.path, "utf8")).toBe(contents);
  });
  it("reports project unreadability without preventing global native refresh", () => {
    const context = fixture("1.0.2", [PI_CHORUS_SPEC]);
    writeFileSync(join(context.cwd, ".pi", "settings.json"), "{bad");
    expect(installPi(context)).toMatchObject({ action: "skipped", detail: expect.stringContaining("current-project Pi settings") });
    expect(installPi({ ...context, readJson: () => { throw new Error("EACCES cho_SECRET"); } }).complete).toBe(false);
  });
  it("reports actual install failures without leaking process output", () => {
    const context = fixture("0.87.1");
    const normal = context.run.getMockImplementation();
    context.run.mockImplementation((cmd, args) => args.includes(PI_LEGACY_ADAPTER_SPEC) ? { ok: false, stderr: "cho_SECRET" } : normal(cmd, args));
    const result = installPi(context);
    expect(result).toMatchObject({ action: "failed", complete: false });
    expect(result.detail).not.toContain("cho_SECRET");
    expect(commands(context)).toHaveLength(1);
  });
  it("never falls back to all-extension updates when targeting is unavailable", () => {
    const context = fixture("1.0.2", [PI_CHORUS_SPEC]);
    context.run.mockImplementation((cmd, args) => ({ ok: true, stdout: args[0] === "--version" ? "1.0.2" : "--extensions" }));
    expect(installPi({ ...context, flags: { updateInstalled: true } })).toMatchObject({ complete: false, detail: expect.stringContaining("targeted update unsupported") });
    expect(commands(context)).toEqual([]);
  });
});

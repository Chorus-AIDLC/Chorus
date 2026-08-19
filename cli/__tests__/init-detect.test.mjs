// cli/__tests__/init-detect.test.mjs
// Covers the cross-platform detection primitives (spec: chorus-init "Agent
// detection with dual signal"). All fs/env/platform injected — no real machine.
import { describe, it, expect } from "vitest";
import { expandPath, binaryOnPath, configDirPresent, detectSignals } from "../init/detect.mjs";

describe("expandPath", () => {
  const home = "/home/u";
  it("expands a leading ~ to home", () => {
    expect(expandPath("~/.claude", { home })).toBe("/home/u/.claude");
  });
  it("expands a leading $VAR segment from env", () => {
    expect(expandPath("$DSH_HOME", { env: { DSH_HOME: "/opt/dsh" }, home })).toBe("/opt/dsh");
    expect(expandPath("$DSH_HOME/x", { env: { DSH_HOME: "/opt/dsh" }, home })).toBe("/opt/dsh/x");
  });
  it("returns null when the $VAR is unset (candidate does not apply)", () => {
    expect(expandPath("$DSH_HOME", { env: {}, home })).toBeNull();
  });
  it("passes a plain absolute path through", () => {
    expect(expandPath("/etc/x", { home })).toBe("/etc/x");
  });
});

describe("binaryOnPath", () => {
  const env = { PATH: "/usr/bin:/usr/local/bin" };
  it("finds a binary that exists in a PATH dir", () => {
    const existsSync = (p) => p === "/usr/local/bin/claude";
    expect(binaryOnPath(["claude"], { env, existsSync, platform: "linux" })).toBe(true);
  });
  it("returns false when no candidate is on PATH", () => {
    expect(binaryOnPath(["nope"], { env, existsSync: () => false, platform: "linux" })).toBe(false);
  });
  it("returns false on an empty PATH", () => {
    expect(binaryOnPath(["claude"], { env: {}, existsSync: () => true, platform: "linux" })).toBe(false);
  });
  it("honors PATHEXT on win32", () => {
    const winEnv = { Path: "C:\\bin", PATHEXT: ".EXE;.CMD" };
    // Match separator-agnostically: node:path.join uses the HOST separator, so on
    // a POSIX test host the joined path has "/" even for win32 platform logic.
    const existsSync = (p) => p.replace(/\\/g, "/").endsWith("bin/codex.CMD");
    expect(binaryOnPath(["codex"], { env: winEnv, existsSync, platform: "win32" })).toBe(true);
  });
});

describe("configDirPresent", () => {
  const home = "/home/u";
  it("true when any expanded dir exists", () => {
    const existsSync = (p) => p === "/home/u/.config/opencode";
    expect(configDirPresent(["~/.config/opencode", "~/.opencode"], { existsSync, home })).toBe(true);
  });
  it("false when none exist", () => {
    expect(configDirPresent(["~/.kiro"], { existsSync: () => false, home })).toBe(false);
  });
  it("skips unresolved $VAR candidates without throwing", () => {
    const existsSync = (p) => p === "/home/u/.dsh";
    expect(configDirPresent(["$DSH_HOME", "~/.dsh"], { env: {}, existsSync, home })).toBe(true);
  });
});

describe("detectSignals", () => {
  it("combines the binary and config-dir signals", () => {
    const d = { binaries: ["kiro"], configDirs: ["~/.kiro"] };
    const existsSync = (p) => p === "/home/u/.kiro"; // dir present, binary absent
    const res = detectSignals(d, { env: { PATH: "/usr/bin" }, existsSync, home: "/home/u", platform: "linux" });
    expect(res).toEqual({ binaryOnPath: false, configDirPresent: true });
  });
});

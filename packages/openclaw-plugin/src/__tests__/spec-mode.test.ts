import { describe, it, expect } from "vitest";
import {
  resolveSpecMode,
  type FsLike,
  type ExecSync,
  type SpecModeResult,
} from "../spec-mode.js";

// ─── resolveSpecMode ─────────────────────────────────────────────────────────
// The TS reimplementation of the canonical bash resolver
// (public/chorus-plugin/bin/resolve-spec-mode.sh). This mirrors that resolver's
// 13-case matrix test (bin/tests/test-spec-mode-resolution.sh) and the chorus-pi
// port's test so the OpenClaw port stays contract-identical: explicit
// CHORUS_SPEC_MODE {lite, openspec, off, <invalid>} × OpenSpec {usable,
// missing-dir, missing-CLI, disabled} + unset. Only mode / chorusOpenspecActive /
// (specFail?) are asserted (as in the bash matrix); reason strings may differ
// across ports.
function fsWith(dirs: string[]): FsLike {
  return { existsSync: (p: string) => dirs.includes(p) };
}
function execOk(): ExecSync {
  return () => {}; // succeeds (CLI present)
}
function execMissing(): ExecSync {
  return () => {
    throw new Error("not found");
  }; // throws (CLI absent)
}

const CWD = "/proj";
const USABLE = { fs: fsWith([`${CWD}/openspec`]), exec: execOk() };
const NO_DIR = { fs: fsWith([]), exec: execOk() };
const NO_CLI = { fs: fsWith([`${CWD}/openspec`]), exec: execMissing() };

// run(label, inputs, fs, exec) → assert {specMode, chorusOpenspecActive, hasFail}
function rsm(
  specMode: string | undefined,
  env: { openspecMode?: string; enableOpenSpec?: string },
  io: { fs: FsLike; exec: ExecSync },
): SpecModeResult {
  return resolveSpecMode({ specMode, projectRoot: CWD, ...env }, io.fs, io.exec);
}
function expectMode(r: SpecModeResult, mode: string, active: boolean, hasFail: boolean) {
  expect(r.specMode).toBe(mode);
  expect(r.chorusOpenspecActive).toBe(active);
  expect(r.specFail !== "").toBe(hasFail);
}

describe("resolveSpecMode (13-case contract matrix)", () => {
  // --- unset ---
  it("unset + usable → openspec", () => {
    expectMode(rsm(undefined, {}, USABLE), "openspec", true, false);
  });
  it("unset + no openspec dir → lite", () => {
    expectMode(rsm(undefined, {}, NO_DIR), "lite", false, false);
  });
  it("unset + dir but no CLI → lite", () => {
    expectMode(rsm(undefined, {}, NO_CLI), "lite", false, false);
  });
  it("unset + disabled(CHORUS_OPENSPEC_MODE=off) → lite", () => {
    expectMode(rsm(undefined, { openspecMode: "off" }, USABLE), "lite", false, false);
  });
  it("unset + disabled(enableOpenSpec toggle) → lite", () => {
    expectMode(rsm(undefined, { enableOpenSpec: "false" }, USABLE), "lite", false, false);
  });

  // --- explicit lite / off ---
  it("lite + usable → lite (never openspec-active)", () => {
    expectMode(rsm("lite", {}, USABLE), "lite", false, false);
  });
  it("off + usable → off", () => {
    expectMode(rsm("off", {}, USABLE), "off", false, false);
  });

  // --- explicit openspec ---
  it("openspec + usable → openspec active", () => {
    expectMode(rsm("openspec", {}, USABLE), "openspec", true, false);
  });
  it("openspec + no dir → FAIL (halt)", () => {
    const r = rsm("openspec", {}, NO_DIR);
    expectMode(r, "openspec", false, true);
    expect(r.specFail).toContain("not usable");
  });
  it("openspec + no CLI → FAIL (halt)", () => {
    expectMode(rsm("openspec", {}, NO_CLI), "openspec", false, true);
  });
  it("openspec + disabled → FAIL (config conflict)", () => {
    const r = rsm("openspec", { openspecMode: "off" }, USABLE);
    expectMode(r, "openspec", false, true);
    expect(r.specFail).toContain("config conflict");
  });

  // --- invalid value falls back to default resolution ---
  it("invalid + usable → openspec (default)", () => {
    expectMode(rsm("bogus", {}, USABLE), "openspec", true, false);
  });
  it("invalid + no dir → lite (default)", () => {
    expectMode(rsm("bogus", {}, NO_DIR), "lite", false, false);
  });
});

describe("resolveSpecMode (reason order + short-circuit)", () => {
  // enableOpenSpec toggle is checked before CHORUS_OPENSPEC_MODE (reason order).
  it("enableOpenSpec=false wins the disabled reason over CHORUS_OPENSPEC_MODE=off", () => {
    const r = rsm(undefined, { enableOpenSpec: "false", openspecMode: "off" }, USABLE);
    expect(r.specMode).toBe("lite");
    expect(r.openspecUsableReason).toContain("enableOpenSpec userConfig=false");
  });

  // CLI probe is skipped when disabled or dir-missing (short-circuit).
  it("CLI probe skipped when disabled or dir missing", () => {
    let calls = 0;
    const exec = (() => {
      calls++;
    }) as unknown as ExecSync;
    resolveSpecMode({ projectRoot: CWD, enableOpenSpec: "false" }, fsWith([`${CWD}/openspec`]), exec);
    expect(calls).toBe(0); // disabled → no probe
    resolveSpecMode({ projectRoot: CWD }, fsWith([]), exec);
    expect(calls).toBe(0); // dir missing → no probe
    resolveSpecMode({ projectRoot: CWD }, fsWith([`${CWD}/openspec`]), exec);
    expect(calls).toBe(1); // dir present → probe once
  });

  // specFail is empty on every non-openspec-explicit path (only explicit
  // openspec-that-can't-be-honored halts).
  it("specFail is empty unless an explicit openspec cannot be honored", () => {
    expect(rsm(undefined, {}, NO_DIR).specFail).toBe("");
    expect(rsm("lite", {}, NO_DIR).specFail).toBe("");
    expect(rsm("off", {}, USABLE).specFail).toBe("");
    expect(rsm("bogus", {}, NO_DIR).specFail).toBe("");
  });
});

import { describe, expect, test } from "vitest";
import {
  buildSpecModeGuidance,
  resolveSpecMode,
  type ExecSync,
  type FsLike,
  type SpecModeResult,
} from "../src/spec-mode.js";

// ─── resolveSpecMode ─────────────────────────────────────────────────────────
// The TS reimplementation of the canonical bash resolver
// (public/chorus-plugin/bin/resolve-spec-mode.sh). This mirrors that resolver's
// 13-case matrix test (bin/tests/test-spec-mode-resolution.sh) so the dsh port
// stays contract-identical: explicit CHORUS_SPEC_MODE {lite, openspec, off,
// <invalid>} × OpenSpec {usable, missing-dir, missing-CLI, disabled} + unset.
// Only mode / chorusOpenspecActive / (specFail?) are asserted (as in the bash
// matrix); reason strings may differ across ports.
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

function rsm(
  specMode: string | undefined,
  env: { openspecMode?: string; enableOpenSpec?: string },
  io: { fs: FsLike; exec: ExecSync },
) {
  return resolveSpecMode({ specMode, projectRoot: CWD, ...env }, io.fs, io.exec);
}
function expectMode(r: SpecModeResult, mode: string, active: boolean, hasFail: boolean) {
  expect(r.specMode).toBe(mode);
  expect(r.chorusOpenspecActive).toBe(active);
  expect(r.specFail !== "").toBe(hasFail);
}

describe("resolveSpecMode — 13-case contract matrix", () => {
  // --- unset ---
  test("unset + usable → openspec", () => {
    expectMode(rsm(undefined, {}, USABLE), "openspec", true, false);
  });
  test("unset + no openspec dir → lite", () => {
    expectMode(rsm(undefined, {}, NO_DIR), "lite", false, false);
  });
  test("unset + dir but no CLI → lite", () => {
    expectMode(rsm(undefined, {}, NO_CLI), "lite", false, false);
  });
  test("unset + disabled(CHORUS_OPENSPEC_MODE=off) → lite", () => {
    expectMode(rsm(undefined, { openspecMode: "off" }, USABLE), "lite", false, false);
  });
  test("unset + disabled(enableOpenSpec toggle) → lite", () => {
    expectMode(rsm(undefined, { enableOpenSpec: "false" }, USABLE), "lite", false, false);
  });

  // --- explicit lite / off ---
  test("lite + usable → lite (never openspec-active)", () => {
    expectMode(rsm("lite", {}, USABLE), "lite", false, false);
  });
  test("off + usable → off", () => {
    expectMode(rsm("off", {}, USABLE), "off", false, false);
  });

  // --- explicit openspec ---
  test("openspec + usable → openspec active", () => {
    expectMode(rsm("openspec", {}, USABLE), "openspec", true, false);
  });
  test("openspec + no dir → FAIL (halt)", () => {
    const r = rsm("openspec", {}, NO_DIR);
    expectMode(r, "openspec", false, true);
    expect(r.specFail).toContain("not usable");
  });
  test("openspec + no CLI → FAIL (halt)", () => {
    expectMode(rsm("openspec", {}, NO_CLI), "openspec", false, true);
  });
  test("openspec + disabled → FAIL (config conflict)", () => {
    const r = rsm("openspec", { openspecMode: "off" }, USABLE);
    expectMode(r, "openspec", false, true);
    expect(r.specFail).toContain("config conflict");
  });

  // --- invalid value falls back to default resolution ---
  test("invalid + usable → openspec (default)", () => {
    expectMode(rsm("bogus", {}, USABLE), "openspec", true, false);
  });
  test("invalid + no dir → lite (default)", () => {
    expectMode(rsm("bogus", {}, NO_DIR), "lite", false, false);
  });
});

describe("resolveSpecMode — reason order + CLI short-circuit", () => {
  // enableOpenSpec toggle is checked before CHORUS_OPENSPEC_MODE (reason order).
  test("enableOpenSpec=false wins the disabled reason over CHORUS_OPENSPEC_MODE=off", () => {
    const r = rsm(undefined, { enableOpenSpec: "false", openspecMode: "off" }, USABLE);
    expect(r.specMode).toBe("lite");
    expect(r.openspecUsableReason).toContain("enableOpenSpec userConfig=false");
  });

  // CLI probe is skipped when disabled or dir-missing (short-circuit).
  test("CLI probe skipped when disabled or dir missing", () => {
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
});

// ─── buildSpecModeGuidance (the `## Spec Mode` block injected at first step) ──
describe("buildSpecModeGuidance", () => {
  function specOf(overrides: Partial<SpecModeResult>): SpecModeResult {
    return {
      specMode: "off",
      specReason: "",
      specFail: "",
      openspecUsable: false,
      openspecUsableReason: "",
      openspecHint: "",
      chorusOpenspecActive: false,
      ...overrides,
    };
  }

  test("always states the resolved CHORUS_SPEC_MODE + reason under a `## Spec Mode` heading", () => {
    const g = buildSpecModeGuidance(specOf({ specMode: "lite", specReason: "default — OpenSpec not usable" }));
    expect(g).toContain("## Spec Mode");
    expect(g).toContain("CHORUS_SPEC_MODE=lite (default — OpenSpec not usable)");
  });

  test("lite → routes to the spec-lite-chorus skill, not openspec", () => {
    const g = buildSpecModeGuidance(specOf({ specMode: "lite" }));
    expect(g).toContain("spec-lite-chorus");
    expect(g).toContain("Routing: lite");
    expect(g).not.toContain("CHORUS_OPENSPEC_ACTIVE=1");
  });

  test("off → free-form, no spec artifact", () => {
    const g = buildSpecModeGuidance(specOf({ specMode: "off" }));
    expect(g).toContain("Routing: off");
    expect(g).toContain("free-form");
  });

  test("openspec (active) → openspec-aware-chorus §3, emits CHORUS_OPENSPEC_ACTIVE=1", () => {
    const g = buildSpecModeGuidance(
      specOf({
        specMode: "openspec",
        chorusOpenspecActive: true,
        openspecUsable: true,
        openspecUsableReason: "openspec/ directory + openspec CLI both present",
      }),
    );
    expect(g).toContain("CHORUS_OPENSPEC_ACTIVE=1");
    expect(g).toContain("openspec-aware-chorus");
  });

  test("specFail (explicit openspec, unusable) → halt route with the failure + hint", () => {
    const g = buildSpecModeGuidance(
      specOf({
        specMode: "openspec",
        specFail: "OpenSpec not usable (no openspec/ directory at /proj/openspec)",
        openspecHint: "npm i -g @fission-ai/openspec && openspec init",
      }),
    );
    expect(g).toContain("cannot be honored");
    expect(g).toContain("MUST halt");
    expect(g).toContain("Install hint: npm i -g @fission-ai/openspec && openspec init");
  });
});

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSpecMode, type ExecSync, type FsLike } from "../spec-mode.js";

// ─── shipped-resolver parity ──────────────────────────────────────────────────
// OpenClaw has no SessionStart channel, so its skills resolve the spec mode
// themselves. That used to mean a hand-rolled bash block inside
// skills/openspec-aware/SKILL.md, which genuinely FORKED from src/spec-mode.ts
// (it ignored the enableOpenSpec toggle and collapsed the two fail reasons), so
// the same repo could resolve `openspec` from the skill and `lite` from the
// plugin. The fix: the package now SHIPS the canonical bash resolver and the
// skill sources it. These tests keep that true — one asserts the skill has no
// second implementation, the other asserts the shipped script and the TS mirror
// agree on the full contract (mode, active flag, fail, and reason strings).

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RESOLVER = join(PKG_ROOT, "bin", "resolve-spec-mode.sh");
const SKILL = join(PKG_ROOT, "skills", "openspec-aware", "SKILL.md");

interface BashResult {
  specMode: string;
  specReason: string;
  specFail: string;
  chorusOpenspecActive: boolean;
}

// Source the shipped resolver under bash with a controlled env + filesystem and
// read its output vars back. `withCli` controls whether an `openspec` executable
// is on PATH (PATH is replaced outright so the host's real CLI can't leak in).
function runBash(
  env: Record<string, string | undefined>,
  opts: { openspecDir: boolean; withCli: boolean },
): BashResult {
  const root = mkdtempSync(join(tmpdir(), "chorus-openclaw-parity-"));
  if (opts.openspecDir) mkdirSync(join(root, "openspec"));
  const binDir = join(root, "fakebin");
  mkdirSync(binDir);
  if (opts.withCli) {
    const cli = join(binDir, "openspec");
    writeFileSync(cli, "#!/bin/sh\nexit 0\n");
    chmodSync(cli, 0o755);
  }
  const script = `. "${RESOLVER}"
printf '%s\\n%s\\n%s\\n%s\\n' "$SPEC_MODE" "$CHORUS_OPENSPEC_ACTIVE" "$SPEC_FAIL" "$SPEC_REASON"`;
  const out = execFileSync("bash", ["-c", script], {
    encoding: "utf8",
    // A bare PATH: only the fake bin plus the dirs bash itself needs.
    env: { PATH: `${binDir}:/usr/bin:/bin`, PROJECT_ROOT: root, ...stripUndefined(env) },
  });
  const [specMode, active, specFail, specReason] = out.split("\n");
  // The reason/fail strings embed the project root; normalize it so the TS side
  // can be asked for the same path.
  const unroot = (s: string) => s.split(root).join("<ROOT>");
  return {
    specMode,
    chorusOpenspecActive: active === "1",
    specFail: unroot(specFail),
    specReason: unroot(specReason),
  };
}

function stripUndefined(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function runTs(
  env: { CHORUS_SPEC_MODE?: string; CHORUS_OPENSPEC_MODE?: string; CLAUDE_PLUGIN_OPTION_ENABLEOPENSPEC?: string },
  opts: { openspecDir: boolean; withCli: boolean },
): BashResult {
  const root = "<ROOT>";
  const fs: FsLike = { existsSync: (p) => opts.openspecDir && p === `${root}/openspec` };
  const exec: ExecSync = () => {
    if (!opts.withCli) throw new Error("not found");
  };
  const r = resolveSpecMode(
    {
      specMode: env.CHORUS_SPEC_MODE,
      openspecMode: env.CHORUS_OPENSPEC_MODE,
      enableOpenSpec: env.CLAUDE_PLUGIN_OPTION_ENABLEOPENSPEC,
      projectRoot: root,
    },
    fs,
    exec,
  );
  return {
    specMode: r.specMode,
    specReason: r.specReason,
    specFail: r.specFail,
    chorusOpenspecActive: r.chorusOpenspecActive,
  };
}

const OPENSPEC_STATES = [
  { label: "usable", openspecDir: true, withCli: true },
  { label: "no openspec/ dir", openspecDir: false, withCli: true },
  { label: "dir but no CLI", openspecDir: true, withCli: false },
] as const;

const MODE_ENVS = [
  { label: "unset", env: {} },
  { label: "lite", env: { CHORUS_SPEC_MODE: "lite" } },
  { label: "off", env: { CHORUS_SPEC_MODE: "off" } },
  { label: "openspec", env: { CHORUS_SPEC_MODE: "openspec" } },
  { label: "invalid", env: { CHORUS_SPEC_MODE: "bogus" } },
  { label: "disabled via CHORUS_OPENSPEC_MODE=off", env: { CHORUS_OPENSPEC_MODE: "off" } },
  { label: "disabled via enableOpenSpec=false", env: { CLAUDE_PLUGIN_OPTION_ENABLEOPENSPEC: "false" } },
  {
    label: "explicit openspec + both opt-outs (reason precedence)",
    env: {
      CHORUS_SPEC_MODE: "openspec",
      CHORUS_OPENSPEC_MODE: "off",
      CLAUDE_PLUGIN_OPTION_ENABLEOPENSPEC: "false",
    },
  },
] as const;

describe("shipped bash resolver ⇄ src/spec-mode.ts parity", () => {
  it("ships the canonical resolver the skill sources", () => {
    expect(existsSync(RESOLVER)).toBe(true);
  });

  for (const state of OPENSPEC_STATES) {
    for (const mode of MODE_ENVS) {
      it(`agrees for ${mode.label} × ${state.label}`, () => {
        const opts = { openspecDir: state.openspecDir, withCli: state.withCli };
        expect(runBash(mode.env, opts)).toEqual(runTs(mode.env, opts));
      });
    }
  }
});

describe("skills/openspec-aware keeps no second resolver", () => {
  const text = () => execFileSync("cat", [SKILL], { encoding: "utf8" });

  it("sources the shipped resolver instead of re-deriving the rule", () => {
    expect(text()).toContain("bin/resolve-spec-mode.sh");
  });

  it("does not hand-roll the resolution in Markdown", () => {
    // These are the tells of a reimplementation: assigning the intermediate
    // usability flag, or probing the CLI / openspec dir directly. Reading the
    // OUTPUT vars ($SPEC_MODE, $SPEC_FAIL, …) is fine — that is the contract.
    for (const forbidden of [/^OPENSPEC_USABLE=/m, /command -v openspec/, /^\s*case "\$\{CHORUS_SPEC_MODE/m]) {
      expect(text()).not.toMatch(forbidden);
    }
  });
});

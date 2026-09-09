/**
 * Spec-mode resolver for the Chorus OpenClaw plugin.
 *
 * This is the TypeScript reimplementation of the canonical bash resolver
 * `public/chorus-plugin/bin/resolve-spec-mode.sh` (which the bash ports copy
 * byte-identically; the TS ports reimplement + ship a same-contract test). It
 * mirrors the chorus-pi port's `resolveSpecMode` in
 * `packages/chorus-pi/lib/lib.ts` and is the **single source of truth** for the
 * spec mode on OpenClaw.
 *
 * OpenClaw has no SessionStart hook and no per-session context-injection
 * channel, so nothing precomputes the mode into the agent's context. Instead:
 *   - the `/chorus` command calls `resolveSpecModeFromEnv` so the resolved mode
 *     is a user-visible surface (its one real runtime caller), and
 *   - the stage skills (proposal / develop / yolo / openspec-aware) resolve the
 *     SAME contract inline, pointing back at this file as the authoritative rule.
 *
 * `resolveSpecMode` itself is pure given injectable fs + execSync, so it can be
 * unit-tested without touching the disk or PATH.
 */

import { existsSync } from "node:fs";
import { execSync } from "node:child_process";

/** Minimal fs surface needed by the resolver (injectable for tests). */
export interface FsLike {
  existsSync(p: string): boolean;
}

/** Minimal execSync surface — used only to probe `command -v openspec`. */
export type ExecSync = (cmd: string, opts: { stdio: "ignore" }) => void;

/**
 * The resolved spec mode surfaced to the agent. `openspec` = the OpenSpec
 * (openspec-aware) path; `lite` = Chorus-native lightweight specs
 * (`.chorus/specs/<slug>/`); `off` = free-form, no spec artifact.
 */
export type SpecMode = "lite" | "openspec" | "off";

/**
 * Inputs to the spec-mode resolver (env values + repo root). Mirrors the
 * canonical bash resolver `public/chorus-plugin/bin/resolve-spec-mode.sh`.
 */
export interface SpecModeInputs {
  /** CHORUS_SPEC_MODE — explicit override: "lite" | "openspec" | "off" (else unset/""). */
  specMode?: string;
  /** CHORUS_OPENSPEC_MODE — legacy opt-out: "off" disables OpenSpec. */
  openspecMode?: string;
  /** CLAUDE_PLUGIN_OPTION_ENABLEOPENSPEC — plugin toggle: "false" disables OpenSpec (default "true"). */
  enableOpenSpec?: string;
  /** Repo root to probe for openspec/. */
  projectRoot: string;
}

/**
 * Resolved spec mode for a repo — the TS mirror of the bash resolver's output
 * vars. `specFail` non-empty ⇒ a stage skill MUST halt (an explicit
 * `CHORUS_SPEC_MODE=openspec` that cannot be honored); `chorusOpenspecActive`
 * is true only when the resolved mode is a USABLE openspec.
 */
export interface SpecModeResult {
  specMode: SpecMode;
  specReason: string;
  specFail: string;
  openspecUsable: boolean;
  openspecUsableReason: string;
  openspecHint: string;
  chorusOpenspecActive: boolean;
}

/**
 * Resolve the active Chorus spec mode for a repo. Pure given injectable fs +
 * execSync.
 *
 * Rule (per owner): an explicit `CHORUS_SPEC_MODE` wins; when unset, OpenSpec
 * stays the default whenever it is usable (openspec/ dir + CLI, not disabled),
 * and lite is the fallback only when OpenSpec is absent or disabled. An explicit
 * `=openspec` that isn't usable fails fast (`specFail`).
 */
export function resolveSpecMode(
  inputs: SpecModeInputs,
  fs: FsLike,
  execSync: ExecSync,
): SpecModeResult {
  const projectRoot = inputs.projectRoot || "";

  // --- Is OpenSpec usable? (needs openspec/ dir + CLI on PATH + not disabled) ---
  // enableOpenSpec toggle is checked BEFORE the legacy CHORUS_OPENSPEC_MODE, so a
  // plugin-level opt-out wins the reason string (matches the bash resolver order).
  let openspecDisabled = false;
  let disabledReason = "";
  if ((inputs.enableOpenSpec ?? "true") !== "true") {
    openspecDisabled = true;
    disabledReason = "enableOpenSpec userConfig=false (plugin-level opt-out)";
  } else if (inputs.openspecMode === "off") {
    openspecDisabled = true;
    disabledReason = "CHORUS_OPENSPEC_MODE=off (legacy opt-out)";
  }

  let openspecUsable = false;
  let openspecUsableReason = "";
  let openspecHint = "";
  if (openspecDisabled) {
    openspecUsableReason = disabledReason;
  } else if (!fs.existsSync(`${projectRoot}/openspec`)) {
    openspecUsableReason = `no openspec/ directory at ${projectRoot}/openspec`;
    openspecHint = "npm i -g @fission-ai/openspec && openspec init";
  } else if (!openspecCliPresent(execSync)) {
    openspecUsableReason = "openspec/ directory present but `openspec` CLI not on PATH";
    openspecHint = "npm i -g @fission-ai/openspec";
  } else {
    openspecUsable = true;
    openspecUsableReason = "openspec/ directory + openspec CLI both present";
  }

  // --- Resolve CHORUS_SPEC_MODE (unset and "" are treated the same, as in bash) ---
  let specMode: SpecMode;
  let specReason: string;
  let specFail = "";
  const raw = inputs.specMode ?? "";
  switch (raw) {
    case "lite":
      specMode = "lite";
      specReason = "explicit — Chorus-native lightweight specs in .chorus/specs/<slug>/";
      break;
    case "off":
      specMode = "off";
      specReason = "explicit — free-form, no spec artifact";
      break;
    case "openspec":
      specMode = "openspec";
      if (openspecUsable) {
        specReason = `explicit; ${openspecUsableReason}`;
      } else if (openspecDisabled) {
        specReason = `explicit, but OpenSpec is disabled: ${openspecUsableReason}`;
        specFail = `config conflict — CHORUS_SPEC_MODE=openspec vs OpenSpec disabled (${openspecUsableReason}); re-enable OpenSpec or set CHORUS_SPEC_MODE=lite`;
      } else {
        specReason = `explicit, but OpenSpec is not installed: ${openspecUsableReason}`;
        specFail = `OpenSpec not usable (${openspecUsableReason})`;
      }
      break;
    case "":
      // Unset: OpenSpec is the default when usable; lite is the fallback otherwise.
      if (openspecUsable) {
        specMode = "openspec";
        specReason = `default — ${openspecUsableReason}; set CHORUS_SPEC_MODE=lite for Chorus-native specs, =off to disable`;
      } else {
        specMode = "lite";
        specReason = `default — OpenSpec not usable (${openspecUsableReason}); using Chorus-native lightweight specs in .chorus/specs/<slug>/`;
      }
      break;
    default:
      // Unrecognized value: treat like unset (OpenSpec-if-usable, else lite).
      if (openspecUsable) {
        specMode = "openspec";
        specReason = `CHORUS_SPEC_MODE='${raw}' unrecognized; falling back to default (${openspecUsableReason})`;
      } else {
        specMode = "lite";
        specReason = `CHORUS_SPEC_MODE='${raw}' unrecognized; OpenSpec not usable, defaulting to lite`;
      }
  }

  const chorusOpenspecActive = specMode === "openspec" && specFail === "";
  return {
    specMode,
    specReason,
    specFail,
    openspecUsable,
    openspecUsableReason,
    openspecHint,
    chorusOpenspecActive,
  };
}

function openspecCliPresent(execSync: ExecSync): boolean {
  try {
    execSync("command -v openspec", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Convenience wrapper that wires the real Node `fs.existsSync` + `child_process.execSync`
 * and reads the spec-mode env vars off a process-env-shaped bag. This is the
 * `/chorus` command's real runtime caller. Kept out of `resolveSpecMode` so the
 * core stays pure/injectable for tests.
 */
export function resolveSpecModeFromEnv(
  env: NodeJS.ProcessEnv,
  projectRoot: string,
): SpecModeResult {
  const fs: FsLike = { existsSync: (p: string) => existsSync(p) };
  const exec: ExecSync = (cmd, opts) => {
    execSync(cmd, opts);
  };
  return resolveSpecMode(
    {
      specMode: env.CHORUS_SPEC_MODE,
      openspecMode: env.CHORUS_OPENSPEC_MODE,
      enableOpenSpec: env.CLAUDE_PLUGIN_OPTION_ENABLEOPENSPEC,
      projectRoot,
    },
    fs,
    exec,
  );
}

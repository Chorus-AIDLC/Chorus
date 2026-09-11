/**
 * Spec-mode resolver for the chorus-dsh bundle.
 *
 * The TypeScript reimplementation of the canonical bash resolver
 * (`public/chorus-plugin/bin/resolve-spec-mode.sh`), kept contract-identical to
 * it and to the other TS ports (chorus-pi's `resolveSpecMode`). Pure given an
 * injectable fs + execSync, so it is unit-testable without a running dsh
 * session (see tests/spec-mode.test.ts, which mirrors the bash 13-case matrix).
 *
 * dsh has no SessionStart hook (unlike the Claude Code plugin), so the bundle
 * computes the mode once at plugin load, publishes `CHORUS_SPEC_MODE` +
 * `CHORUS_OPENSPEC_ACTIVE` to the process environment, and injects a
 * `## Spec Mode` block (buildSpecModeGuidance) into the first agent step.
 */

/** Minimal fs surface needed by the resolver. Injected so tests can stub the disk. */
export interface FsLike {
  existsSync(p: string): boolean;
}

/** execSync surface used to probe the `openspec` CLI on PATH. Injected for tests. */
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

function openspecCliPresent(execSync: ExecSync): boolean {
  try {
    execSync("command -v openspec", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the active Chorus spec mode for a repo — the TypeScript reimplementation
 * of `public/chorus-plugin/bin/resolve-spec-mode.sh` (which the bash ports copy
 * byte-identically; the TS ports reimplement + ship a same-contract test). Pure
 * given injectable fs + execSync.
 *
 * Rule (per owner): an explicit `CHORUS_SPEC_MODE` wins; when unset, OpenSpec stays
 * the default whenever it is usable (openspec/ dir + CLI, not disabled), and lite
 * is the fallback only when OpenSpec is absent or disabled. An explicit
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

/**
 * Build the `## Spec Mode` block injected into the first agent step (the dsh
 * equivalent of the Claude plugin's SessionStart `## Spec Mode` context and the
 * Codex `on-session-start.sh` block). States `CHORUS_SPEC_MODE=<mode> (<reason>)`
 * plus the route note for the resolved mode:
 *   - lite     → follow the `spec-lite-chorus` skill
 *   - off      → free-form, no spec artifact
 *   - openspec → follow the `openspec-aware-chorus` skill §3
 *   - specFail → halt (explicit openspec that cannot be honored)
 *
 * Pure (no I/O) so it can be unit-tested. Skills are loaded via the dsh `skill`
 * tool by name; document mirrors go through `chorus mcp call --arg-file`, with
 * the package-local `$CHORUS_MCP_CALL` (`chorus-mcp-call.mjs`) wrapper as the
 * CLI-absent fallback.
 */
export function buildSpecModeGuidance(spec: SpecModeResult): string {
  const route =
    spec.specMode === "lite"
      ? "Routing: lite → follow the `spec-lite-chorus` skill (load it via the `skill` tool). A capability's durable spec is `.chorus/specs/<slug>/spec.md` (edited in place, **never synced** — git history is its record); each change is a dated folder `.chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/` of Chorus-typed docs (`prd.md` required; `tech_design.md` / `adr.md` / `guide.md` / `spec.md` optional) that **are** mirrored 1:1 into persistent Chorus Documents via `chorus mcp call … --arg-file content=<file>` (fallback: the package-local `$CHORUS_MCP_CALL` wrapper). Put a `Spec-lite: .chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/` locator line in the proposal description. Do NOT scaffold `openspec/changes/` or add an `OpenSpec change slug:` line."
      : spec.specMode === "off"
        ? "Routing: off → free-form, no spec artifact. Do NOT create `.chorus/specs/` or `openspec/changes/` files; author document drafts inline via direct MCP."
        : spec.specFail
          ? `Routing: openspec → **cannot be honored** — ${spec.specFail}. The proposal / yolo skill MUST halt after resolving the mode; do NOT silently fall back to spec-lite/free-form. Surface this to the user.${spec.openspecHint ? ` Install hint: ${spec.openspecHint}.` : ""}`
          : `CHORUS_OPENSPEC_ACTIVE=1 (${spec.openspecUsableReason})\n\nRouting: openspec → load the \`openspec-aware-chorus\` skill (via the \`skill\` tool) and follow §3 (OpenSpec authoring) — do NOT re-run the §1 detection block, the answer is already known.\n\nCritical rule (openspec-aware-chorus §2 Rule 1): document mirror calls (\`chorus_pm_add_document_draft\` / \`chorus_pm_update_document_draft\` / \`chorus_pm_update_document\`) MUST fill \`content\` from the local file — prefer \`chorus mcp call <tool> '<json>' --arg-file content=<file>\`, falling back to the package-local \`$CHORUS_MCP_CALL\` wrapper when \`chorus\` is not on PATH. Do NOT invoke these MCP tools directly with hand-typed \`content\` in OpenSpec mode.`;
  return [
    "## Spec Mode",
    "",
    `CHORUS_SPEC_MODE=${spec.specMode} (${spec.specReason})`,
    "",
    route,
  ].join("\n");
}

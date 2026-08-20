// cli/init/install-methods.mjs
// Per-agent plugin-surface install functions (descriptor.install hooks). Each
// takes a StepContext and returns a StepOutcome. Every command shape below was
// verified against the agent's REAL CLI `--help` (not LLM memory) — see the
// per-function VERIFIED notes. Agents whose install cannot be verified ship a
// guided message via `guided()` rather than a guessed command.
//
// All shell-outs go through ctx.run (default cli/init/run-command.mjs) so this
// unit-tests without executing anything. Nothing here writes MCP config or
// credentials — plugin surface only.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./run-command.mjs";
import { binaryOnPath } from "./detect.mjs";
import { OUTCOME_ACTIONS } from "./contracts.mjs";
import { CHORUS_PLUGIN_ID, CHORUS_MARKETPLACE_NAME, CHORUS_MARKETPLACE_SOURCE } from "./chorus-plugin-consts.mjs";

const STEP_ID = "plugin-install";
const { INSTALLED, REPAIRED, SKIPPED, FAILED, UNSUPPORTED } = OUTCOME_ACTIONS;

const out = (agentId, action, detail) => ({ stepId: STEP_ID, agentId, action, detail });

/** First non-empty line of a command result's stderr/stdout, trimmed short. */
function errText(r) {
  const t = (r?.stderr || r?.error || r?.stdout || "").trim().split("\n")[0] || "unknown error";
  return t.length > 160 ? `${t.slice(0, 157)}…` : t;
}

/** Read the adapter's install state defensively. `extra` carries per-agent deps
 *  the state reader needs beyond `env` (e.g. dsh's chosen `profile`). */
function safeState(ctx, extra = {}) {
  try {
    return ctx.adapter?.readInstallState?.({ env: ctx.env, ...extra }) ?? {};
  } catch {
    return {};
  }
}

/** A non-empty trimmed string, or undefined. */
function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readTextSafe(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Claude Code — VERIFIED against Claude Code 2.1.235:
//   `claude plugin marketplace add <url|path|repo>`
//   `claude plugin install <plugin@marketplace> -y`  (-y required when non-TTY)
// State is read from ~/.claude/plugins/installed_plugins.json (read-only).
// ---------------------------------------------------------------------------
export function installClaude(ctx) {
  const run = ctx.run ?? runCommand;
  const env = ctx.env ?? process.env;
  const source = env.CHORUS_MARKETPLACE_SOURCE || CHORUS_MARKETPLACE_SOURCE;
  const state = safeState(ctx);
  if (state.pluginInstalled) {
    return out("claude", SKIPPED, `already installed${state.version ? ` (v${state.version})` : ""}`);
  }
  if (!state.marketplaceRegistered) {
    const r = run("claude", ["plugin", "marketplace", "add", source], { env });
    if (!r.ok) return out("claude", FAILED, `claude plugin marketplace add failed: ${errText(r)}`);
  }
  const r2 = run("claude", ["plugin", "install", CHORUS_PLUGIN_ID, "-y"], { env });
  if (!r2.ok) return out("claude", FAILED, `claude plugin install failed: ${errText(r2)}`);
  return out("claude", state.marketplaceRegistered ? REPAIRED : INSTALLED, `installed ${CHORUS_PLUGIN_ID} via claude plugin CLI`);
}

// ---------------------------------------------------------------------------
// Codex — VERIFIED against codex-cli 0.146.1:
//   `codex plugin marketplace add <SOURCE>`   (SOURCE = local path | owner/repo[@ref] | Git URL)
//   `codex plugin add <PLUGIN@MARKETPLACE> --json`
// config.toml is backed up before the CLI mutates it.
// ---------------------------------------------------------------------------
export function readCodexInstallState({ env = process.env } = {}) {
  const home = env.HOME || homedir();
  const codexHome = env.CODEX_HOME || join(home, ".codex");
  const toml = readTextSafe(join(codexHome, "config.toml")) || "";
  return {
    marketplaceRegistered: toml.includes(`[marketplaces.${CHORUS_MARKETPLACE_NAME}]`),
    pluginInstalled: toml.includes(`[plugins."${CHORUS_PLUGIN_ID}"]`),
  };
}

export function installCodex(ctx) {
  const run = ctx.run ?? runCommand;
  const env = ctx.env ?? process.env;
  const home = env.HOME || homedir();
  const codexHome = env.CODEX_HOME || join(home, ".codex");
  // Codex accepts owner/repo; allow an override, else the canonical repo slug.
  const source = env.CHORUS_MARKETPLACE_SOURCE_CODEX || "Chorus-AIDLC/Chorus";
  const state = safeState(ctx);
  if (state.pluginInstalled) return out("codex", SKIPPED, "already installed (config.toml)");

  ctx.backup?.(join(codexHome, "config.toml")); // back up before the CLI edits it
  if (!state.marketplaceRegistered) {
    const r = run("codex", ["plugin", "marketplace", "add", source], { env });
    if (!r.ok) return out("codex", FAILED, `codex plugin marketplace add failed: ${errText(r)}`);
  }
  const r2 = run("codex", ["plugin", "add", CHORUS_PLUGIN_ID, "--json"], { env });
  if (!r2.ok) return out("codex", FAILED, `codex plugin add failed: ${errText(r2)}`);
  return out("codex", state.marketplaceRegistered ? REPAIRED : INSTALLED, `installed ${CHORUS_PLUGIN_ID} via codex plugin CLI`);
}

// ---------------------------------------------------------------------------
// opencode — VERIFIED against opencode 1.14.33:
//   `opencode plugin <module>`  ("install plugin and update config")
// module name "opencode-chorus" from public/install-opencode.sh. opencode.json
// is backed up before the CLI mutates it.
// ---------------------------------------------------------------------------
const OPENCODE_PLUGIN_MODULE = "opencode-chorus";

export function readOpencodeInstallState({ env = process.env } = {}) {
  const home = env.HOME || homedir();
  const dir = env.OPENCODE_CONFIG_DIR || join(home, ".config", "opencode");
  const cfg = readJsonSafe(join(dir, "opencode.json"));
  const plugins = Array.isArray(cfg?.plugin) ? cfg.plugin : [];
  return {
    marketplaceRegistered: false, // opencode has no marketplace concept
    pluginInstalled: plugins.some((p) => typeof p === "string" && p.includes(OPENCODE_PLUGIN_MODULE)),
  };
}

export function installOpencode(ctx) {
  const run = ctx.run ?? runCommand;
  const env = ctx.env ?? process.env;
  const home = env.HOME || homedir();
  const dir = env.OPENCODE_CONFIG_DIR || join(home, ".config", "opencode");
  const state = safeState(ctx);
  if (state.pluginInstalled) return out("opencode", SKIPPED, "already in opencode.json plugin list");

  ctx.backup?.(join(dir, "opencode.json")); // back up before the CLI edits it
  // `-g` writes the GLOBAL ~/.config/opencode/opencode.json (the same file
  // readOpencodeInstallState checks); without it opencode installs project-local
  // (cwd), which would defeat idempotency for a machine-wide `chorus init`.
  const r = run("opencode", ["plugin", OPENCODE_PLUGIN_MODULE, "-g"], { env });
  if (!r.ok) return out("opencode", FAILED, `opencode plugin install failed: ${errText(r)}`);
  return out("opencode", INSTALLED, `installed ${OPENCODE_PLUGIN_MODULE} via opencode plugin -g`);
}

// ---------------------------------------------------------------------------
// dsh (DeepSeek Harness) — VERIFIED against docs/CONNECT_DSH.md (dsh 0.1.0-rc.7):
//   `dsh plugin --profile <name> add @chorus-aidlc/chorus-dsh -w`   (-w MANDATORY:
//   a dsh profile is a pnpm workspace root; pnpm refuses to add a dependency to a
//   workspace root without it).
// Prereq: `pnpm` on PATH — dsh delegates package management to pnpm. This configures
// only the INTERACTIVE dsh profile; it NEVER touches the daemon-managed composition
// (cli/dsh-spawner.mjs). The `--profile <name>` is resolved from an explicit flag/env
// or a TTY prompt — NEVER guessed. dsh's profile-store enumeration is NOT verifiable
// on this build host (no dsh CLI present), so we DEGRADE to prompt-for-name rather
// than hardcode a guessed `dsh profile list` subcommand; wire the real enumeration
// once a dsh CLI is available. Credentials are handled elsewhere ($DSH_HOME/.env via
// the credential flow) — this installer writes no secret.
// ---------------------------------------------------------------------------
const DSH_BUNDLE = "@chorus-aidlc/chorus-dsh";

export function readDshInstallState({ env = process.env, profile } = {}) {
  // Best-effort, per-profile idempotency probe. A dsh profile is a pnpm workspace
  // root under $DSH_HOME (docs/CONNECT_DSH.md); a profile that has added the bundle
  // records it in that root's package.json. The exact layout is NOT verifiable here,
  // so this degrades to "not installed" if it differs (dsh's own `add` is idempotent)
  // — never a false positive, never a throw. Called with no `profile` (registry-level
  // detection, which does not know the user's pick) it reports not-installed.
  if (!profile) return { marketplaceRegistered: false, pluginInstalled: false };
  const home = env.HOME || homedir();
  const dshHome = env.DSH_HOME || join(home, ".dsh");
  const pkg = readJsonSafe(join(dshHome, profile, "package.json"));
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  return {
    marketplaceRegistered: false, // dsh has no marketplace concept
    pluginInstalled: Object.prototype.hasOwnProperty.call(deps, DSH_BUNDLE),
  };
}

/** Resolve the dsh profile: explicit flag/env pre-fill, else a TTY name prompt.
 *  Returns the profile name, or null when none can be resolved without guessing. */
async function resolveDshProfile(ctx) {
  const env = ctx.env ?? process.env;
  const flags = ctx.flags ?? {};
  const io = ctx.io ?? {};
  // 1. Explicit: --dsh-profile flag or CHORUS_DSH_PROFILE env pre-fill.
  const explicit = nonEmpty(flags.dshProfile) ?? nonEmpty(env.CHORUS_DSH_PROFILE);
  if (explicit) return explicit;
  // 2. Interactive: prompt for the profile NAME on a TTY (no enumeration — see header).
  if (io.isTTY && typeof io.ask === "function") {
    return nonEmpty(await io.ask("dsh profile to add the Chorus bundle to (name): ")) ?? null;
  }
  // 3. No explicit profile and no TTY to ask → caller fails (never guess a profile).
  return null;
}

export async function installDsh(ctx) {
  const run = ctx.run ?? runCommand;
  const env = ctx.env ?? process.env;

  // Precheck: pnpm on PATH. Probe via PATH (NOT `run`) so a missing pnpm returns
  // FAILED with ZERO commands executed. Injectable for unit tests.
  const hasBinary = ctx.binaryOnPath ?? binaryOnPath;
  if (!hasBinary(["pnpm"], { env })) {
    return out("dsh", FAILED, "pnpm not found on PATH — dsh delegates package management to pnpm; install pnpm and re-run");
  }

  // Profile resolution — NEVER guess (a wrong profile mutates the wrong workspace).
  const profile = await resolveDshProfile(ctx);
  if (!profile) {
    return out("dsh", FAILED, "no dsh profile resolved — pass --dsh-profile <name> or set CHORUS_DSH_PROFILE (a TTY prompts); never a guessed profile");
  }

  // Idempotency: skip when the chosen profile already carries the bundle.
  const state = safeState(ctx, { profile });
  if (state.pluginInstalled) return out("dsh", SKIPPED, `already installed in dsh profile '${profile}'`);

  const r = run("dsh", ["plugin", "--profile", profile, "add", DSH_BUNDLE, "-w"], { env });
  if (!r.ok) return out("dsh", FAILED, `dsh plugin add failed: ${errText(r)}`);
  return out("dsh", INSTALLED, `installed ${DSH_BUNDLE} into dsh profile '${profile}'`);
}

// ---------------------------------------------------------------------------
// Guided (not automated). These agents have no verified native REMOTE-marketplace
// install path, so — per the "no guessed command" rule — we surface a precise
// next step instead of running an unverified command.
// ---------------------------------------------------------------------------
export function guided(agentId, detail) {
  return () => out(agentId, UNSUPPORTED, detail);
}

export const GUIDED_MESSAGES = {
  kiro: "Kiro uses a file-template install (.kiro/ directory), not a remote marketplace — run the Kiro installer (public/install-kiro.sh) to drop the Chorus .kiro/ template.",
  openclaw: "OpenClaw loads its plugin from a linked/compiled directory (no remote-marketplace CLI) — install the OpenClaw Chorus plugin per its plugin docs.",
  pi: "Pi installs extensions via `pi install <source>`; the Chorus Pi extension source is not wired into chorus init yet — install it manually with `pi install <source>`.",
};

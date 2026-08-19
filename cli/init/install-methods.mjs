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

/** Read the adapter's install state defensively. */
function safeState(ctx) {
  try {
    return ctx.adapter?.readInstallState?.({ env: ctx.env }) ?? {};
  } catch {
    return {};
  }
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
  dsh: "DeepSeek Harness integrates with Chorus via a published MCP-client bundle configured in $DSH_HOME/cordis.patch.yml, not a plugin surface — use the dsh Chorus MCP installer, not chorus init.",
};

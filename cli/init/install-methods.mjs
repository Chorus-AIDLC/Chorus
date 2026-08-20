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
import { fileURLToPath } from "node:url";
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
// OpenClaw — VERIFIED against packages/openclaw-plugin/README.md (Installation §,
// lines 32-35) + package.json `openclaw.install`:
//   `openclaw plugins install npm:@chorus-aidlc/chorus-openclaw-plugin`
//   `openclaw plugins enable chorus-openclaw-plugin`
// The install SOURCE carries the `npm:` prefix; the enable/disable/uninstall ARG
// is the bare plugin id `chorus-openclaw-plugin` (README line 60). OpenClaw
// installs from npm — there is NO marketplace step (unlike claude/codex).
//
// Host-version guard: the npm install path ships COMPILED runtimeExtensions
// (dist/index.js) that bind to OpenClaw SDK APIs added in a specific host
// version (`activation.onStartup`, 2026.4.27); a below-floor host cannot load the
// plugin. The floor is READ from the plugin package's `openclaw.install.minHostVersion`
// (openclawMinHostVersion) — never hardcoded here — and enforced BEFORE any
// install/enable, so an old host gets a precise "upgrade" message and ZERO mutation.
//
// VERIFIED-gap: the openclaw CLI is NOT present on this build host, so (a) the exact
// `openclaw --version` output shape is not confirmed — parseOpenclawVersion extracts
// the first dotted-numeric token defensively rather than assuming a fixed format; and
// (b) plugin state is read from ~/.openclaw/openclaw.json under
// `plugins.entries.chorus-openclaw-plugin` (README "Where config lives", lines 66-72),
// degrading to "not installed" if absent — never a false positive. `openclaw --version`
// is the task-directed probe.
// ---------------------------------------------------------------------------
const OPENCLAW_PLUGIN_ID = "chorus-openclaw-plugin";
const OPENCLAW_NPM_SPEC = "npm:@chorus-aidlc/chorus-openclaw-plugin";

// The chorus CLI is published (root package.json `files`) WITHOUT packages/, so
// this file is not co-located in a published npm layout — openclawMinHostVersion
// degrades to this documented mirror of packages/openclaw-plugin/package.json →
// openclaw.install.minHostVersion. In the repo/dev tree the package block itself
// is the source of truth (read below); keep this in sync with it.
const OPENCLAW_MIN_HOST_VERSION_FALLBACK = "2026.4.27";
const OPENCLAW_PACKAGE_JSON_URL = new URL("../../packages/openclaw-plugin/package.json", import.meta.url);

/** The OpenClaw host-version floor, READ from the plugin package's
 *  `openclaw.install.minHostVersion` (NOT hardcoded). Strips a leading range
 *  operator (`>=`) to a bare dotted version. Degrades to the documented mirror
 *  only when the package.json cannot be read (stripped npm layout). `pkgUrl` is
 *  injectable for tests. */
export function openclawMinHostVersion({ pkgUrl = OPENCLAW_PACKAGE_JSON_URL } = {}) {
  let raw;
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8"));
    raw = pkg?.openclaw?.install?.minHostVersion;
  } catch {
    raw = undefined;
  }
  const cleaned = typeof raw === "string" ? raw.replace(/[^\d.]/g, "").trim() : "";
  return cleaned || OPENCLAW_MIN_HOST_VERSION_FALLBACK;
}

/** First dotted-numeric token in `openclaw --version` output, or null. Tolerant
 *  of `openclaw 2026.4.27`, `v2026.4.27`, `2026.4.27-rc.1`, etc. */
function parseOpenclawVersion(text) {
  const m = String(text ?? "").match(/\d+(?:\.\d+)+/);
  return m ? m[0] : null;
}

/** Compare two dotted-numeric versions → -1 / 0 / 1 (a<b / a==b / a>b).
 *  Zero-dependency; covers OpenClaw CalVer (`2026.4.27`) and plain semver. */
function compareVersions(a, b) {
  const pa = String(a).split(".");
  const pb = String(b).split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = parseInt(pa[i] ?? "0", 10) || 0;
    const nb = parseInt(pb[i] ?? "0", 10) || 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

export function readOpenclawInstallState({ env = process.env } = {}) {
  const home = env.HOME || homedir();
  const dir = env.OPENCLAW_CONFIG_DIR || join(home, ".openclaw");
  const cfg = readJsonSafe(join(dir, "openclaw.json"));
  const entry = cfg?.plugins?.entries?.[OPENCLAW_PLUGIN_ID];
  const pluginInstalled = !!entry && typeof entry === "object";
  return {
    marketplaceRegistered: false, // openclaw installs from npm — no marketplace concept
    pluginInstalled,
    // `enabled` is an explicit boolean in the config; absent/false ⇒ installed-but-disabled.
    pluginEnabled: pluginInstalled && entry.enabled === true,
  };
}

export function installOpenclaw(ctx) {
  const run = ctx.run ?? runCommand;
  const env = ctx.env ?? process.env;
  const state = safeState(ctx);

  // Already installed AND enabled → nothing to do. No version probe needed: an
  // enabled-and-loaded plugin necessarily already satisfied the host floor.
  if (state.pluginInstalled && state.pluginEnabled) {
    return out("openclaw", SKIPPED, "already installed and enabled");
  }

  // Host-version guard BEFORE any mutation (install OR enable). A below-floor host
  // cannot load the compiled plugin, so refuse with a precise upgrade message and
  // run NOTHING rather than leave an "enabled"-but-nonloading plugin.
  const minVersion = ctx.minHostVersion ?? openclawMinHostVersion();
  const vr = run("openclaw", ["--version"], { env });
  const hostVersion = parseOpenclawVersion(`${vr?.stdout ?? ""}\n${vr?.stderr ?? ""}`);
  if (!vr?.ok || !hostVersion) {
    return out("openclaw", FAILED, `could not determine openclaw version (need >=${minVersion}): ${errText(vr)}`);
  }
  if (compareVersions(hostVersion, minVersion) < 0) {
    return out("openclaw", UNSUPPORTED, `openclaw ${hostVersion} is below the required >=${minVersion} for the Chorus plugin — upgrade openclaw and re-run (no install attempted)`);
  }

  // Installed-but-disabled → enable only (repair).
  if (state.pluginInstalled) {
    const re = run("openclaw", ["plugins", "enable", OPENCLAW_PLUGIN_ID], { env });
    if (!re.ok) return out("openclaw", FAILED, `openclaw plugins enable failed: ${errText(re)}`);
    return out("openclaw", REPAIRED, `enabled ${OPENCLAW_PLUGIN_ID} (was installed but disabled)`);
  }

  // Fresh → install from npm, then enable.
  const ri = run("openclaw", ["plugins", "install", OPENCLAW_NPM_SPEC], { env });
  if (!ri.ok) return out("openclaw", FAILED, `openclaw plugins install failed: ${errText(ri)}`);
  const re = run("openclaw", ["plugins", "enable", OPENCLAW_PLUGIN_ID], { env });
  if (!re.ok) return out("openclaw", FAILED, `openclaw plugins enable failed: ${errText(re)}`);
  return out("openclaw", INSTALLED, `installed ${OPENCLAW_NPM_SPEC} and enabled ${OPENCLAW_PLUGIN_ID}`);
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
  pi: "Pi installs extensions via `pi install <source>`; the Chorus Pi extension source is not wired into chorus init yet — install it manually with `pi install <source>`.",
};

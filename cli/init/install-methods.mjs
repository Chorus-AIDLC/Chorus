// cli/init/install-methods.mjs
// Per-agent plugin-surface install functions (descriptor.install hooks). Each
// takes a StepContext and returns a StepOutcome. Every command shape below was
// verified against the agent's REAL CLI `--help` (not LLM memory) — see the
// per-function VERIFIED notes. Agents whose install cannot be verified ship a
// guided message via `guided()` rather than a guessed command.
//
// All shell-outs go through ctx.run (default cli/init/run-command.mjs) so this
// unit-tests without executing anything. These functions write the plugin surface
// (and, per agent, the MCP-server config that references credentials by env-var —
// e.g. Codex's keyless [mcp_servers.chorus] bearer_token_env_var, Kiro's ${env:...}
// mcp.json) — but NEVER a literal API key/secret (those live in the credential sinks).

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./run-command.mjs";
import { binaryOnPath } from "./detect.mjs";
import { installFileTemplate } from "./file-template.mjs";
import { OUTCOME_ACTIONS } from "./contracts.mjs";
import { CHORUS_PLUGIN_ID, CHORUS_MARKETPLACE_NAME, CHORUS_MARKETPLACE_SOURCE } from "./chorus-plugin-consts.mjs";
import { writeCodexMcpServer } from "./codex-mcp-config.mjs";
import { resolveCredentials } from "../credentials.mjs";

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
// Claude Code — VERIFIED LIVE against Claude Code 2.1.250:
//   `claude plugin marketplace add <url|path|repo>`
//   `claude plugin install <plugin@marketplace> -y`  (-y required when non-TTY)
//   `claude plugin update <plugin@marketplace> -y`
// State is read from ~/.claude/plugins/installed_plugins.json (read-only).
// ---------------------------------------------------------------------------
export function installClaude(ctx) {
  const run = ctx.run ?? runCommand;
  const env = ctx.env ?? process.env;
  const source = env.CHORUS_MARKETPLACE_SOURCE || CHORUS_MARKETPLACE_SOURCE;
  const state = safeState(ctx);
  if (state.pluginInstalled) {
    if (ctx.flags?.updateInstalled) {
      const r = run("claude", ["plugin", "update", CHORUS_PLUGIN_ID, "-y"], { env });
      if (!r.ok) return out("claude", FAILED, `claude plugin update failed: ${errText(r)}`);
      return out("claude", REPAIRED, `updated ${CHORUS_PLUGIN_ID} to latest via claude plugin update`);
    }
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
// Codex — VERIFIED against codex-cli 0.146.1 / 0.150.1:
//   `codex plugin marketplace add <SOURCE>`   (SOURCE = local path | owner/repo[@ref] | Git URL)
//   `codex plugin marketplace upgrade [MARKETPLACE_NAME]`
//   `codex plugin add <PLUGIN@MARKETPLACE> --json`
// config.toml is backed up before the CLI mutates it.
//
// Codex is the ONE exception to this file's "plugin surface only" rule: `codex plugin add`
// does NOT write the native-MCP block (its marketplace `authentication: ON_INSTALL` is
// metadata only — verified codex-cli 0.150.1), so after the plugin install we write
// `[mcp_servers.chorus]` ourselves with a KEYLESS `bearer_token_env_var = "CHORUS_API_KEY"`
// (writeCodexMcpServer). Codex resolves that env var — which ~/.codex/.env populates — into
// the Authorization header at connect time, so the API key stays only in ~/.codex/.env and a
// daemon-woken Codex authenticates too. No secret is written into config.toml.
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
  const configPath = join(codexHome, "config.toml");
  // Codex accepts owner/repo; allow an override, else the canonical repo slug.
  const source = env.CHORUS_MARKETPLACE_SOURCE_CODEX || "Chorus-AIDLC/Chorus";
  const state = safeState(ctx);
  const writeMcp = ctx.writeCodexMcpServer ?? writeCodexMcpServer;
  const resolveCreds = ctx.resolveCredentials ?? resolveCredentials;
  // URL for the [mcp_servers.chorus] block. Prefer the explicit flag/env; otherwise fall
  // back to the credential resolver, which reads the URL from ~/.chorus/daemon.json
  // (agents[0]) — that covers the interactive path where the operator typed the URL at a
  // prompt (credential-seed, order 10, already wrote it there before this step runs).
  let chorusUrl = nonEmpty(ctx.flags?.url) ?? nonEmpty(env.CHORUS_URL);
  if (!chorusUrl) {
    try {
      chorusUrl = nonEmpty(resolveCreds(ctx.flags ?? {}, { env }).url);
    } catch {
      chorusUrl = undefined; // no complete credentials resolved — ensureMcp() skips with a note
    }
  }

  // Ensure the native-MCP block is present + normalized to the keyless bearer_token_env_var
  // form. Idempotent; runs on both fresh install and re-run. Never writes a secret. A missing
  // URL is a non-fatal skip (the plugin surface is still installed). Returns a note suffix.
  const ensureMcp = () => {
    if (!chorusUrl) {
      return " (skipped [mcp_servers.chorus]: no Chorus URL — pass --url or set CHORUS_URL)";
    }
    try {
      writeMcp({ configPath, url: chorusUrl });
      return ' and wrote [mcp_servers.chorus] (bearer_token_env_var="CHORUS_API_KEY")';
    } catch (err) {
      return ` (WARNING: could not write [mcp_servers.chorus]: ${errText({ error: err?.message ?? String(err) })})`;
    }
  };

  if (state.pluginInstalled) {
    ctx.backup?.(configPath); // back up before we normalize the MCP block
    if (ctx.flags?.updateInstalled) {
      if (!state.marketplaceRegistered) {
        const ra = run("codex", ["plugin", "marketplace", "add", source], { env });
        if (!ra.ok) return out("codex", FAILED, `codex plugin marketplace add failed: ${errText(ra)}`);
      }
      const ru = run("codex", ["plugin", "marketplace", "upgrade", CHORUS_MARKETPLACE_NAME], { env });
      if (!ru.ok) return out("codex", FAILED, `codex plugin marketplace upgrade failed: ${errText(ru)}`);
      const rp = run("codex", ["plugin", "add", CHORUS_PLUGIN_ID, "--json"], { env });
      if (!rp.ok) return out("codex", FAILED, `codex plugin add failed: ${errText(rp)}`);
      return out(
        "codex",
        REPAIRED,
        `refreshed ${CHORUS_MARKETPLACE_NAME} and reinstalled ${CHORUS_PLUGIN_ID}${ensureMcp()}`,
      );
    }
    return out("codex", SKIPPED, `already installed (config.toml)${ensureMcp()}`);
  }

  ctx.backup?.(configPath); // back up before the CLI edits it
  if (!state.marketplaceRegistered) {
    const r = run("codex", ["plugin", "marketplace", "add", source], { env });
    if (!r.ok) return out("codex", FAILED, `codex plugin marketplace add failed: ${errText(r)}`);
  }
  const r2 = run("codex", ["plugin", "add", CHORUS_PLUGIN_ID, "--json"], { env });
  if (!r2.ok) return out("codex", FAILED, `codex plugin add failed: ${errText(r2)}`);
  return out(
    "codex",
    state.marketplaceRegistered ? REPAIRED : INSTALLED,
    `installed ${CHORUS_PLUGIN_ID} via codex plugin CLI${ensureMcp()}`,
  );
}

// ---------------------------------------------------------------------------
// opencode — VERIFIED LIVE against opencode 1.14.33:
//   `opencode plugin <module>`  ("install plugin and update config")
//   `--global` targets the user config; `--force` replaces an existing version.
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
  if (state.pluginInstalled && !ctx.flags?.updateInstalled) {
    return out("opencode", SKIPPED, "already in opencode.json plugin list");
  }

  ctx.backup?.(join(dir, "opencode.json")); // back up before the CLI edits it
  // `-g` writes the GLOBAL ~/.config/opencode/opencode.json (the same file
  // readOpencodeInstallState checks); without it opencode installs project-local
  // (cwd), which would defeat idempotency for a machine-wide `chorus init`.
  const args = ["plugin", OPENCODE_PLUGIN_MODULE, "-g"];
  if (state.pluginInstalled) args.push("--force");
  const r = run("opencode", args, { env });
  if (!r.ok) return out("opencode", FAILED, `opencode plugin install failed: ${errText(r)}`);
  return state.pluginInstalled
    ? out("opencode", REPAIRED, `updated ${OPENCODE_PLUGIN_MODULE} to latest via opencode plugin -g --force`)
    : out("opencode", INSTALLED, `installed ${OPENCODE_PLUGIN_MODULE} via opencode plugin -g`);
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
  // records it in that root's package.json. Before an interactive profile has
  // been chosen, inspect the live profiles/<name> store so runInit can include
  // dsh in its one invocation-wide installed-plugin refresh decision.
  const home = env.HOME || homedir();
  const dshHome = env.DSH_HOME || join(home, ".dsh");
  let candidates;
  if (profile) {
    candidates = [
      join(dshHome, "profiles", profile, "package.json"),
      join(dshHome, profile, "package.json"),
    ];
  } else {
    try {
      candidates = readdirSync(join(dshHome, "profiles"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(dshHome, "profiles", entry.name, "package.json"));
    } catch {
      candidates = [];
    }
  }
  const packagePath = candidates.find((path) => {
    const pkg = readJsonSafe(path);
    const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
    return Object.prototype.hasOwnProperty.call(deps, DSH_BUNDLE);
  });
  return {
    marketplaceRegistered: false, // dsh has no marketplace concept
    pluginInstalled: !!packagePath,
    packagePath: packagePath ?? (profile ? candidates[0] : undefined),
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
  if (state.pluginInstalled && !ctx.flags?.updateInstalled) {
    return out("dsh", SKIPPED, `already installed in dsh profile '${profile}'`);
  }
  if (state.pluginInstalled) ctx.backup?.(state.packagePath);

  const r = run("dsh", ["plugin", "--profile", profile, "add", DSH_BUNDLE, "-w"], { env });
  if (!r.ok) return out("dsh", FAILED, `dsh plugin add failed: ${errText(r)}`);
  return state.pluginInstalled
    ? out("dsh", REPAIRED, `updated ${DSH_BUNDLE} to latest in dsh profile '${profile}'`)
    : out("dsh", INSTALLED, `installed ${DSH_BUNDLE} into dsh profile '${profile}'`);
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
  if (state.pluginInstalled && state.pluginEnabled && !ctx.flags?.updateInstalled) {
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
  if (state.pluginInstalled && !ctx.flags?.updateInstalled) {
    const re = run("openclaw", ["plugins", "enable", OPENCLAW_PLUGIN_ID], { env });
    if (!re.ok) return out("openclaw", FAILED, `openclaw plugins enable failed: ${errText(re)}`);
    return out("openclaw", REPAIRED, `enabled ${OPENCLAW_PLUGIN_ID} (was installed but disabled)`);
  }

  // Fresh or accepted refresh → install from npm, then ensure enabled. Back up
  // the mutable host config before an installed payload is refreshed.
  if (state.pluginInstalled) {
    const home = env.HOME || homedir();
    const dir = env.OPENCLAW_CONFIG_DIR || join(home, ".openclaw");
    ctx.backup?.(join(dir, "openclaw.json"));
  }
  const ri = run("openclaw", ["plugins", "install", OPENCLAW_NPM_SPEC], { env });
  if (!ri.ok) return out("openclaw", FAILED, `openclaw plugins install failed: ${errText(ri)}`);
  const re = run("openclaw", ["plugins", "enable", OPENCLAW_PLUGIN_ID], { env });
  if (!re.ok) return out("openclaw", FAILED, `openclaw plugins enable failed: ${errText(re)}`);
  return state.pluginInstalled
    ? out("openclaw", REPAIRED, `reinstalled latest ${OPENCLAW_NPM_SPEC} and ensured ${OPENCLAW_PLUGIN_ID} is enabled`)
    : out("openclaw", INSTALLED, `installed ${OPENCLAW_NPM_SPEC} and enabled ${OPENCLAW_PLUGIN_ID}`);
}

// ---------------------------------------------------------------------------
// Kiro — NATIVE FILE-TEMPLATE install (Kiro has NO plugin CLI). Its "plugin" is a
// set of loose files under .kiro/ (what public/install-kiro.sh drops). We
// re-implement that drop cross-platform in pure JS (no bash/curl), downloading
// the assets from the connected Chorus instance via file-template.mjs.
//
// The .kiro/ layout is mirrored verbatim from install-kiro.sh (the VERIFIED
// reference): KIRO_DIR = ~/.kiro (global) unless env.KIRO_DIR overrides it;
// skills/agents/steering/hooks + __CHORUS_BIN__ substitution + a `chorus` server
// merged (non-destructively) into settings/mcp.json with the key kept as a
// ${env:...} reference. "Installed" = skills + agents/chorus.json + the chorus
// mcp server all present; a re-run repairs only the missing delta.
// ---------------------------------------------------------------------------
/** True when <skillsDir> holds at least one <name>/SKILL.md (manifest-agnostic so
 *  it stays correct in the stripped npm package where the manifest isn't bundled). */
function kiroSkillsPopulated(skillsDir) {
  try {
    return readdirSync(skillsDir).some((name) => existsSync(join(skillsDir, name, "SKILL.md")));
  } catch {
    return false;
  }
}

export function readKiroInstallState({ env = process.env } = {}) {
  const home = env.HOME || homedir();
  const kiroDir = env.KIRO_DIR || join(home, ".kiro");
  const agentPresent = existsSync(join(kiroDir, "agents", "chorus.json"));
  const mcp = readJsonSafe(join(kiroDir, "settings", "mcp.json"));
  const mcpServerPresent = !!(mcp && typeof mcp === "object" && mcp.mcpServers && mcp.mcpServers.chorus);
  const skillsPresent = kiroSkillsPopulated(join(kiroDir, "skills"));
  return {
    marketplaceRegistered: false, // kiro has no marketplace concept — it's a file drop
    pluginInstalled: skillsPresent && agentPresent && mcpServerPresent,
    skillsPresent,
    agentPresent,
    mcpServerPresent,
  };
}

export async function installKiro(ctx) {
  const env = ctx.env ?? process.env;
  const home = env.HOME || homedir();
  const kiroDir = env.KIRO_DIR || join(home, ".kiro");
  // chorus init already holds the connection URL (flag/env); the .kiro/ template
  // is downloaded from that instance, so a missing URL is a hard failure.
  const chorusUrl = nonEmpty(ctx.flags?.url) ?? nonEmpty(env.CHORUS_URL);

  const state = safeState(ctx);
  if (state.pluginInstalled && !ctx.flags?.updateInstalled) {
    return out("kiro", SKIPPED, `already installed (${kiroDir})`);
  }

  if (!chorusUrl) {
    return out("kiro", FAILED, "no Chorus URL — pass --url or set CHORUS_URL so the .kiro/ template can be downloaded from the connected instance");
  }

  // Any chorus-* asset already present ⇒ this is a delta repair, not a fresh drop.
  const repairing = !!(state.pluginInstalled || state.skillsPresent || state.agentPresent || state.mcpServerPresent);
  try {
    const res = await installFileTemplate({
      chorusUrl,
      kiroDir,
      fetchImpl: ctx.fetch,
      backup: ctx.backup,
      platform: ctx.platform,
      log: ctx.io?.log,
    });
    return out(
      "kiro",
      repairing ? REPAIRED : INSTALLED,
      `${repairing ? "repaired" : "installed"} the .kiro/ template (${res.skills} skills, ${res.reviewerAgents} reviewer agents, ${res.hookScripts} hooks) → ${kiroDir}; merged the chorus server into settings/mcp.json`,
    );
  } catch (err) {
    return out("kiro", FAILED, err?.message ?? String(err));
  }
}

// ---------------------------------------------------------------------------
// Guided (not automated). These agents have no verified native install path, so
// — per the "no guessed command" rule — we surface a precise next step instead
// of running an unverified command.
// ---------------------------------------------------------------------------
export function guided(agentId, detail) {
  // Tag the returned function so adapters.mjs can tell a GUIDED (unsupported)
  // install apart from a real automated one — both are `typeof === "function"`,
  // but only a real installer sets `supported: true`. Without this marker every
  // guided agent would report supported:true (the pre-existing latent bug).
  const fn = () => out(agentId, UNSUPPORTED, detail);
  fn.guided = true;
  return fn;
}

export const GUIDED_MESSAGES = {
  // Pi HAS an extension surface (`pi install <source>`) — this message must NOT
  // claim otherwise. What's missing is a published Chorus Pi extension for
  // `chorus agents add` to install automatically, so the accurate guidance is the real
  // manual command against that source once it's available.
  pi: "Pi installs extensions with `pi install <source>`; Chorus does not yet publish a Pi extension for `chorus agents add` to automate, so install it manually with `pi install <source>` when a Chorus Pi source is available.",
};

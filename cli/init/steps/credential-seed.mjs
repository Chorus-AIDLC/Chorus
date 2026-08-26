// cli/init/steps/credential-seed.mjs
// The `once`-scoped step that captures Chorus credentials for `chorus init` and
// seeds them into the centralized daemon config (~/.chorus/daemon.json). It loops
// the init SELECTION (ctx.selection) and captures ONE Chorus key per selected
// agent, writing each as its own `agents[]` entry tagged with the daemon agentType
// its adapter maps to (cli/init/agent-type-map.mjs — claude→claude-code, codex,
// kiro, everything else→offline). This is how one `chorus init` run wires several
// agents into a single daemon at once (daemon-multi-agent).
//
// It reuses the existing, tested credential plumbing:
//   - validateAndFetchIdentity (cli/chorus-client.mjs) to validate each key
//   - appendAgentConfig (cli/login.mjs) to APPEND each validated agent to
//     `agents[]` without disturbing any other agent (migration + dedup handled
//     there), all through the MERGE-SAFE updateDaemonConfig writer that preserves
//     yoloAckAt / cwds / sigintTimeoutMs.
//
// It writes credentials ONLY into `agents[]` — the flat top-level url/apiKey
// (+ identity) agent config is DEPRECATED and is no longer written here (writing
// both duplicated the first agent: once flat, once in agents[]). Single-credential
// consumers still resolve fine: `resolveCredentials` (cli/credentials.mjs) falls
// back to `agents[0]` when the flat pair is absent, and the multi-agent resolver
// reads `agents[]` directly.
//
// dsh EXCEPTION — a SECOND credential sink: when a selected agent is DeepSeek
// Harness (`dsh`), this step ALSO seeds CHORUS_URL + CHORUS_API_KEY +
// CHORUS_AGENT_PROFILE into `$DSH_HOME/.env` (see writeDshCredentialsEnv). That
// file is dsh's ESTABLISHED
// credential channel (formerly written by the now-retired public/dsh-credentials.sh):
// dsh scrubs credential-shaped env from tool subprocesses, so the dsh doc-mirror
// wrapper (packages/chorus-dsh/bin/chorus-mcp-call.mjs) reads it via node:util
// parseEnv when the `chorus` CLI is absent from PATH. daemon.json alone does NOT
// reach that wrapper, hence the dual write. It is dsh-ONLY — no other agent gets
// a .env — and is NOT a general per-agent secret mechanism.
//
// Key handling: keys are validated then written 0600 (via updateDaemonConfig) and
// never echoed. A subsequent selected agent is NEVER given the first agent's key —
// on a non-TTY where its key can't be captured, the agent is REPORTED as still
// needing one rather than silently reusing an identity.
//
// Runs BEFORE plugin-install (order 10 < 20) so a machine is authenticated before
// its agents are wired.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { STEP_SCOPES, OUTCOME_ACTIONS } from "../contracts.mjs";
import {
  prompt as defaultPrompt,
  appendAgentConfig as defaultAppendAgentConfig,
} from "../../login.mjs";
import { resolveInstallCwds as defaultResolveInstallCwds } from "../../daemon-install-config.mjs";
import { validateAndFetchIdentity } from "../../chorus-client.mjs";
import { agentTypeForSelection, isWakeableAgentType } from "../agent-type-map.mjs";

const STEP_ID = "credential-seed";
const { SEEDED, SKIPPED, FAILED } = OUTCOME_ACTIONS;
const out = (action, detail, extra) => ({ stepId: STEP_ID, action, detail, ...(extra ?? {}) });

/** A non-empty trimmed string, or undefined. */
function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Whether an init selection id is the DeepSeek Harness (dsh). dsh needs a SECOND
 * credential sink beyond ~/.chorus/daemon.json — see {@link writeDshCredentialsEnv}.
 * We gate on the selection id, NOT the daemon agentType: dsh maps to the shared
 * "offline" agentType (agent-type-map.mjs) alongside opencode/openclaw/pi, so the
 * agentType cannot single dsh out. The id can.
 * @param {string} id
 */
function isDshSelection(id) {
  return id === "dsh";
}

/**
 * Resolve $DSH_HOME the same way dsh (and the retired public/dsh-credentials.sh)
 * did: `env.DSH_HOME` trimmed if set, else `~/.dsh`.
 * @param {Record<string, string | undefined>} env
 */
function resolveDshHome(env) {
  return nonEmpty(env.DSH_HOME) ?? join(homedir(), ".dsh");
}

/**
 * Merge-preserving upsert of CHORUS_URL + CHORUS_API_KEY into `$DSH_HOME/.env`,
 * faithfully taking over what the RETIRED public/dsh-credentials.sh used to write.
 *
 * This is dsh's ESTABLISHED credential channel — NOT a new general per-agent
 * secret write. dsh scrubs credential-shaped variables from tool subprocesses, so
 * its doc-mirror wrapper (packages/chorus-dsh/bin/chorus-mcp-call.mjs) reads the
 * credential keys (CHORUS_URL / CHORUS_API_KEY) from `$DSH_HOME/.env` via node:util
 * `parseEnv` whenever the `chorus` CLI is absent from PATH (e.g. invoked via `npx`
 * rather than the documented `npm install -g @chorus-aidlc/chorus@0.17.0`
 * global-install path). Only a `dsh` selection ever reaches this writer; every
 * other agent gets no .env.
 *
 * CHORUS_AGENT_PROFILE (the agent's UUID) is written here too, but for a DIFFERENT
 * reason than the credentials: it is NOT credential-shaped, so dsh does NOT scrub
 * it — dsh loads `$DSH_HOME/.env` into the session, and the profile reaches tools
 * (including the wrapper) directly on `process.env`. Persisting it here is what lets
 * `chorus agents add` skip the manual `export CHORUS_AGENT_PROFILE=…` hint for dsh
 * (init.mjs profileExportHint), and pins WHICH agent dsh acts as when several are
 * configured (the wrapper then delegates `chorus mcp call --agent <profile>`).
 *
 * Behavior (mirrors the old shell writer):
 *   - Preserves every unrelated line verbatim.
 *   - Upserts CHORUS_URL / CHORUS_API_KEY, plus CHORUS_AGENT_PROFILE when provided
 *     (replacing an existing line in place — with or without an `export ` prefix,
 *     and collapsing any duplicates — else appending). Idempotent: a re-run with
 *     the same values reproduces the file.
 *   - Creates `$DSH_HOME` + the file if absent. Atomic write (temp + rename) at
 *     mode 0600.
 *
 * The secret is only ever written into the 0600 file — never argv, never a log.
 * (The profile is a UUID, not a secret.)
 *
 * @param {{ dshHome: string, url: string, apiKey: string, agentProfile?: string }} args
 * @param {{
 *   read?: (p: string) => string,
 *   write?: (p: string, c: string, o: object) => void,
 *   mkdir?: (p: string, o: object) => void,
 *   rename?: (from: string, to: string) => void,
 * }} [deps]
 * @returns {string} the .env path written
 */
export function writeDshCredentialsEnv({ dshHome, url, apiKey, agentProfile }, deps = {}) {
  const read = deps.read ?? ((p) => readFileSync(p, "utf8"));
  const write = deps.write ?? writeFileSync;
  const mkdir = deps.mkdir ?? mkdirSync;
  const rename = deps.rename ?? renameSync;

  const envPath = join(dshHome, ".env");

  let existing = "";
  try {
    existing = read(envPath);
  } catch {
    existing = ""; // no file yet — start fresh
  }

  // Managed keys: the two credential keys always; CHORUS_AGENT_PROFILE (the agent's
  // UUID) when one was resolved. Only managed keys are rewritten — any other line
  // (including a stale CHORUS_AGENT_PROFILE when none is provided this run) is kept
  // verbatim, so the unrelated-line contract holds.
  const upserts = { CHORUS_URL: url, CHORUS_API_KEY: apiKey };
  if (nonEmpty(agentProfile)) upserts.CHORUS_AGENT_PROFILE = agentProfile.trim();
  const managedKeys = Object.keys(upserts);
  const keyLine = new RegExp(`^\\s*(?:export\\s+)?(${managedKeys.join("|")})\\s*=`);
  const seen = new Set();

  const lines = existing.length ? existing.split(/\r?\n/) : [];
  // Drop a single trailing empty element from a final newline so idempotent
  // re-runs never accumulate blank lines.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  const outLines = [];
  for (const line of lines) {
    const m = line.match(keyLine);
    if (m) {
      const key = m[1];
      if (!seen.has(key)) {
        outLines.push(`${key}=${upserts[key]}`); // replace in place
        seen.add(key);
      }
      continue; // drop this (and any later duplicate) managed line
    }
    outLines.push(line); // preserve unrelated line verbatim
  }
  // Append any managed key not already present (stable order).
  for (const key of managedKeys) {
    if (!seen.has(key)) outLines.push(`${key}=${upserts[key]}`);
  }

  const content = outLines.join("\n") + "\n";

  mkdir(dshHome, { recursive: true });
  // Atomic write: temp file (0600) in the same dir, then rename over target.
  const tmp = `${envPath}.tmp`;
  write(tmp, content, { mode: 0o600 });
  rename(tmp, envPath);
  return envPath;
}

/**
 * Whether an init selection id is Claude Code (`claude`). Claude Code gets a SECOND
 * credential sink beyond ~/.chorus/daemon.json — its user-global ~/.claude/settings.json
 * `env` block — so INTERACTIVE Claude Code authenticates with no manual export (the plugin
 * `.mcp.json` interpolates `${CHORUS_URL}`/`${CHORUS_API_KEY}` from that env at session
 * start). We gate on the selection id, NOT the mapped daemon agentType (`claude` →
 * "claude-code"). Mirrors {@link isDshSelection}.
 * @param {string} id
 */
function isClaudeSelection(id) {
  return id === "claude";
}

/**
 * Resolve the USER-GLOBAL Claude Code settings.json path. Honors `CLAUDE_CONFIG_DIR` (which
 * replaces ~/.claude wholesale per Claude Code docs), then `HOME` (so tests can inject a
 * temp home), else the OS home dir. ALWAYS the user-global file — NEVER a project-level
 * `.claude/settings.json` (git-tracked; would leak the `cho_` key) or `.claude/settings.local.json`.
 * @param {Record<string, string | undefined>} env
 */
function resolveClaudeSettingsPath(env) {
  const base = nonEmpty(env.CLAUDE_CONFIG_DIR) ?? join(nonEmpty(env.HOME) ?? homedir(), ".claude");
  return join(base, "settings.json");
}

/**
 * Read the `CHORUS_AGENT_PROFILE` currently recorded in a Claude Code settings.json `env`
 * block, for cross-run REPOINT detection. Returns undefined on a missing / unreadable /
 * malformed file or when no such key exists — callers treat undefined as "no prior
 * identity" (safe to write). Never throws.
 * @param {string} settingsPath
 * @param {{ read?: (p: string) => string }} [deps]
 * @returns {string | undefined}
 */
export function readClaudeSettingsProfile(settingsPath, deps = {}) {
  const read = deps.read ?? ((p) => readFileSync(p, "utf8"));
  try {
    const parsed = JSON.parse(read(settingsPath));
    const env = parsed && typeof parsed === "object" ? parsed.env : undefined;
    return env && typeof env === "object" && !Array.isArray(env) ? nonEmpty(env.CHORUS_AGENT_PROFILE) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Merge-preserving upsert of CHORUS_URL + CHORUS_API_KEY (+ CHORUS_AGENT_PROFILE) into the
 * `env` block of the user-global ~/.claude/settings.json. The Claude Code analogue of
 * {@link writeDshCredentialsEnv}: same invariants (idempotent, 0600, atomic temp+rename,
 * key never echoed), but the target is a JSON object rather than a dotenv file.
 *
 * settings.json `env` is injected at session start BEFORE the MCP client connects and is
 * inherited by hook + Bash/CLI subprocesses, so this one write satisfies native MCP auth
 * (`.mcp.json` `${VAR}` interpolation), the plugin hooks, AND the skill `chorus` CLI — no
 * manual export. (Verified against Claude Code docs mcp.md / env-vars.md.)
 *
 * Behavior:
 *   - Missing file → start from `{}` (create the config dir if absent).
 *   - Existing but UNPARSEABLE JSON, a non-object root, or a present-but-non-object `env`
 *     → THROW (never clobber a file we cannot safely merge; the caller treats a throw as a
 *     write failure and keeps the export hint).
 *   - Upserts ONLY the three managed keys into `parsed.env`; every other env key and every
 *     other top-level field is preserved verbatim.
 *   - Atomic write: temp file (0600) in the same dir, then rename over the target.
 *   - Idempotent: a re-run with the same values reproduces the file.
 *
 * The API key is only ever written into the 0600 file — never argv, never a log.
 * @param {{ settingsPath: string, url: string, apiKey: string, agentProfile?: string }} args
 * @param {{
 *   read?: (p: string) => string,
 *   write?: (p: string, c: string, o: object) => void,
 *   mkdir?: (p: string, o: object) => void,
 *   rename?: (from: string, to: string) => void,
 * }} [deps]
 * @returns {string} the settings.json path written
 */
export function writeClaudeSettingsEnv({ settingsPath, url, apiKey, agentProfile }, deps = {}) {
  const read = deps.read ?? ((p) => readFileSync(p, "utf8"));
  const write = deps.write ?? writeFileSync;
  const mkdir = deps.mkdir ?? mkdirSync;
  const rename = deps.rename ?? renameSync;

  let raw;
  try {
    raw = read(settingsPath);
  } catch {
    raw = undefined; // no file yet — start fresh
  }

  let parsed = {};
  if (typeof raw === "string" && raw.trim()) {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`existing ${settingsPath} is not valid JSON (${err?.message ?? err}) — refusing to overwrite`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`existing ${settingsPath} is not a JSON object — refusing to overwrite`);
    }
  }

  // Preserve an existing `env` object; a present-but-non-object `env` is unsafe to merge.
  let envBlock = parsed.env;
  if (envBlock === undefined || envBlock === null) {
    envBlock = {};
  } else if (typeof envBlock !== "object" || Array.isArray(envBlock)) {
    throw new Error(`existing ${settingsPath} has a non-object "env" block — refusing to overwrite`);
  }

  const merged = { ...envBlock, CHORUS_URL: url, CHORUS_API_KEY: apiKey };
  if (nonEmpty(agentProfile)) merged.CHORUS_AGENT_PROFILE = agentProfile.trim();
  parsed.env = merged;

  const content = `${JSON.stringify(parsed, null, 2)}\n`;

  mkdir(dirname(settingsPath), { recursive: true });
  // Atomic write: temp file (0600) in the same dir, then rename over target.
  const tmp = `${settingsPath}.tmp`;
  write(tmp, content, { mode: 0o600 });
  rename(tmp, settingsPath);
  return settingsPath;
}

/**
 * Whether an init selection id is Codex (`codex`). Codex gets a SECOND credential sink
 * beyond ~/.chorus/daemon.json — the `[shell_environment_policy].set` table of its own
 * ~/.codex/config.toml — so INTERACTIVE Codex's plugin hooks + shell-tool `chorus` calls
 * resolve identity with no manual export. Codex's native MCP is already export-free (the
 * installer bakes a literal Bearer into config.toml), but the hooks never auto-single, so
 * they still need CHORUS_URL/CHORUS_API_KEY/CHORUS_AGENT_PROFILE in the env. We gate on the
 * selection id, NOT the mapped daemon agentType (`codex` → "codex"). Mirrors
 * {@link isDshSelection} / {@link isClaudeSelection}.
 * @param {string} id
 */
function isCodexSelection(id) {
  return id === "codex";
}

/**
 * Resolve the Codex config.toml path. Honors `CODEX_HOME` (Codex's own override, same as
 * cli/codex-spawner.mjs + install-methods.mjs), then `HOME` (so tests can inject a temp
 * home), else the OS home dir — matching how the Codex install/spawn code already resolves
 * `~/.codex`. The literal `[mcp_servers.chorus]` Bearer already lives in this file; this
 * write only touches `[shell_environment_policy].set`.
 * @param {Record<string, string | undefined>} env
 */
function resolveCodexConfigPath(env) {
  const base = nonEmpty(env.CODEX_HOME) ?? join(nonEmpty(env.HOME) ?? homedir(), ".codex");
  return join(base, "config.toml");
}

/**
 * Merge-preserving upsert of CHORUS_URL + CHORUS_API_KEY + CHORUS_AGENT_PROFILE into the
 * `[shell_environment_policy].set` table of ~/.codex/config.toml. The Codex analogue of
 * {@link writeClaudeSettingsEnv} / {@link writeDshCredentialsEnv}: same invariants
 * (idempotent, 0600, atomic temp+rename, key never echoed), but the target is a TOML file.
 *
 * Codex's `[shell_environment_policy].set` injects env into Codex's exec/shell tool, and the
 * plugin hook wrapper (chorus-mcp-call.sh) prefers CHORUS_AGENT_PROFILE + the `chorus` CLI
 * and falls back to url+key — so writing all three feeds both paths and satisfies the hook's
 * url+key preflight. (Verified against the Codex plugin hooks + CC's chorus-api.sh.)
 *
 * TARGETED TEXTUAL upsert — NOT a TOML parse+reserialize. The repo has no TOML-parser
 * dependency and must stay pure-JS/cross-platform; a reserialize would reformat the file and
 * disturb the literal `[mcp_servers.chorus]` Bearer + comments. So the edit touches only the
 * managed keys and preserves every other section/key/comment verbatim.
 *
 * Behavior:
 *   - Missing file → start fresh with a `[shell_environment_policy.set]` section.
 *   - `[shell_environment_policy.set]` header present → upsert the three keys within that
 *     section (replacing in place, dropping any duplicate managed line), preserving all
 *     other keys in the section and everything else in the file.
 *   - `[shell_environment_policy]` present with an inline `set = { … }` table → THROW (a
 *     textual edit of an inline table is unsafe; the caller treats a throw as a write
 *     failure and keeps the manual-export hint). Configure it via a `[shell_environment_policy.set]`
 *     section instead.
 *   - Otherwise → append a fresh `[shell_environment_policy.set]` section.
 *   - Atomic 0600 temp+rename; idempotent (a re-run with the same values reproduces the file).
 *
 * The API key is only ever written into the 0600 file — never argv, never a log.
 * @param {{ configPath: string, url: string, apiKey: string, agentProfile: string }} args
 * @param {{
 *   read?: (p: string) => string,
 *   write?: (p: string, c: string, o: object) => void,
 *   mkdir?: (p: string, o: object) => void,
 *   rename?: (from: string, to: string) => void,
 * }} [deps]
 * @returns {string} the config.toml path written
 */
export function writeCodexShellEnvCreds({ configPath, url, apiKey, agentProfile }, deps = {}) {
  const read = deps.read ?? ((p) => readFileSync(p, "utf8"));
  const write = deps.write ?? writeFileSync;
  const mkdir = deps.mkdir ?? mkdirSync;
  const rename = deps.rename ?? renameSync;

  const u = nonEmpty(url);
  const k = nonEmpty(apiKey);
  const prof = nonEmpty(agentProfile);
  if (!u || !k || !prof) {
    throw new Error("writeCodexShellEnvCreds requires url, apiKey, and agentProfile");
  }

  // TOML basic-string value: escape backslash then double-quote. URLs / cho_ keys / UUIDs
  // don't contain these, but escape defensively so we never emit invalid TOML.
  const toToml = (v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const managed = { CHORUS_URL: u, CHORUS_API_KEY: k, CHORUS_AGENT_PROFILE: prof };
  const managedKeys = Object.keys(managed);
  const kvLine = (key) => `${key} = ${toToml(managed[key])}`;

  let existing = "";
  try {
    existing = read(configPath);
  } catch {
    existing = ""; // no file yet — start fresh
  }

  const isTableHeader = (s) => /^\s*\[/.test(s);
  const setHeaderRe = /^\s*\[shell_environment_policy\.set\]\s*$/;
  const polHeaderRe = /^\s*\[shell_environment_policy\]\s*$/;
  const keyRe = new RegExp(`^\\s*(${managedKeys.join("|")})\\s*=`);

  const lines = existing.length ? existing.split(/\r?\n/) : [];
  // Drop a single trailing empty element from a final newline so idempotent re-runs never
  // accumulate blank lines (mirrors writeDshCredentialsEnv).
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  const setIdx = lines.findIndex((l) => setHeaderRe.test(l));

  let outLines;
  if (setIdx !== -1) {
    // Upsert within the existing [shell_environment_policy.set] section (header .. next
    // top-level table header, exclusive, or EOF).
    let end = lines.length;
    for (let j = setIdx + 1; j < lines.length; j += 1) {
      if (isTableHeader(lines[j])) {
        end = j;
        break;
      }
    }
    const seen = new Set();
    const sectionOut = [];
    for (let j = setIdx + 1; j < end; j += 1) {
      const m = lines[j].match(keyRe);
      if (m) {
        const key = m[1];
        if (!seen.has(key)) {
          sectionOut.push(kvLine(key)); // replace in place
          seen.add(key);
        }
        continue; // drop this (and any later duplicate) managed line
      }
      sectionOut.push(lines[j]); // preserve unrelated line verbatim
    }
    for (const key of managedKeys) if (!seen.has(key)) sectionOut.push(kvLine(key));
    outLines = [...lines.slice(0, setIdx + 1), ...sectionOut, ...lines.slice(end)];
  } else {
    // No dotted-table section. If a `[shell_environment_policy]` header carries an INLINE
    // `set = { … }`, refuse to edit it textually (unsafe) — treat as a write failure.
    const polIdx = lines.findIndex((l) => polHeaderRe.test(l));
    if (polIdx !== -1) {
      let end = lines.length;
      for (let j = polIdx + 1; j < lines.length; j += 1) {
        if (isTableHeader(lines[j])) {
          end = j;
          break;
        }
      }
      for (let j = polIdx + 1; j < end; j += 1) {
        if (/^\s*set\s*=/.test(lines[j])) {
          throw new Error(
            `existing ${configPath} has an inline [shell_environment_policy] set = { … } table — ` +
              "refusing to edit it; configure it via a [shell_environment_policy.set] section instead",
          );
        }
      }
    }
    const block = ["[shell_environment_policy.set]", ...managedKeys.map(kvLine)];
    outLines = lines.length === 0 ? block : [...lines, "", ...block];
  }

  const content = outLines.join("\n") + "\n";

  mkdir(dirname(configPath), { recursive: true });
  // Atomic write: temp file (0600) in the same dir, then rename over target.
  const tmp = `${configPath}.tmp`;
  write(tmp, content, { mode: 0o600 });
  rename(tmp, configPath);
  return configPath;
}

/**
 * @param {import("../contracts.mjs").StepContext & {
 *   validateCredentials?: Function, appendAgent?: Function, writeLogin?: Function,
 *   promptFn?: Function,
 * }} ctx
 * @returns {Promise<import("../contracts.mjs").StepOutcome | import("../contracts.mjs").StepOutcome[]>}
 */
export async function seedCredentials(ctx) {
  const env = ctx.env ?? process.env;
  const io = ctx.io ?? {};
  const isTTY = !!io.isTTY;
  const flags = ctx.flags ?? {};
  const validate = ctx.validateCredentials ?? validateAndFetchIdentity;
  const append = ctx.appendAgent ?? defaultAppendAgentConfig;
  const resolveCwds = ctx.resolveInstallCwds ?? defaultResolveInstallCwds;
  const ask = ctx.promptFn ?? defaultPrompt;
  const writeDshEnv = ctx.writeDshEnv ?? writeDshCredentialsEnv;
  const writeClaudeSettings = ctx.writeClaudeSettings ?? writeClaudeSettingsEnv;
  const readSettingsProfile = ctx.readClaudeSettingsProfile ?? readClaudeSettingsProfile;
  const writeCodexEnv = ctx.writeCodexEnv ?? writeCodexShellEnvCreds;

  const selection = Array.isArray(ctx.selection) ? ctx.selection.filter((id) => nonEmpty(id)) : [];
  if (selection.length === 0) {
    return out(SKIPPED, "no agents selected — no credentials to seed");
  }

  // The Chorus server URL is shared across all selected agents (one Chorus
  // instance). Resolve it once from flags/env, prompting a single time on a TTY.
  let url = nonEmpty(flags.url) ?? nonEmpty(env.CHORUS_URL);
  if (!url && isTTY && typeof ask === "function") {
    url = nonEmpty(await ask("Chorus URL: "));
  }

  // Resolve the served working-directory SET once and stamp it PER-AGENT into each
  // agents[] entry below. The daemon reads cwds per agent (cfg.cwds is authoritative);
  // the flat top-level `cwds` is a deprecated single-agent leftover — writeConfig is a
  // no-op here so we take only the resolved value, never a top-level write (daemon-setup
  // no longer writes it either). Failure degrades to no cwds (daemon defaults to cwd).
  let cwds = [];
  try {
    const resolved = await resolveCwds(flags, {
      isTTY,
      skip: !isTTY || flags.yes === true,
      writeConfig: () => {},
      readJson: ctx.readJson,
      loginPath: ctx.loginPath,
      prompt: ask,
      log: typeof io.log === "function" ? io.log : () => {},
    });
    cwds = Array.isArray(resolved?.cwds) ? resolved.cwds : [];
  } catch {
    cwds = [];
  }

  /** @type {import("../contracts.mjs").StepOutcome[]} */
  const outcomes = [];

  for (let i = 0; i < selection.length; i += 1) {
    const id = selection[i];
    const agentType = agentTypeForSelection(id);

    // Key capture: the FIRST agent pre-fills from --api-key / CHORUS_API_KEY; every
    // agent prompts on a TTY. A later agent is NEVER handed an earlier agent's key.
    let apiKey = i === 0 ? nonEmpty(flags.apiKey) ?? nonEmpty(env.CHORUS_API_KEY) : undefined;
    if (!apiKey && isTTY && typeof ask === "function") {
      apiKey = nonEmpty(await ask(`Chorus API key for ${id} (cho_...): `, { mask: true }));
    }

    if (!url || !apiKey) {
      // Cannot capture this agent's own key (non-TTY, nothing pre-filled). Report it
      // — never silently reuse another identity's key across agents.
      const missing = !url ? "URL + API key" : "API key";
      outcomes.push(
        out(
          FAILED,
          `${id}: missing Chorus ${missing} — pass --url/--api-key (first agent) or run interactively; ` +
            `this agent still needs its own key`,
        ),
      );
      continue;
    }

    let identity;
    try {
      identity = await validate({ url, apiKey });
    } catch (err) {
      outcomes.push(out(FAILED, `${id}: credential validation failed: ${err?.message ?? String(err)}`));
      continue;
    }

    // daemon-wake opt-in (only for a daemon-wakeable backend; offline agents can never
    // be woken, so they get NO daemonWake field). DEFAULT off: an added agent is parked
    // (its key serves `chorus mcp`) but not woken until the operator opts in — via
    // `--daemon-wake <ids>` / `--daemon-wake-all`, or a per-agent prompt on a TTY.
    let daemonWake;
    if (isWakeableAgentType(agentType)) {
      const flaggedAll = flags.daemonWakeAll === true;
      const flaggedThis = Array.isArray(flags.daemonWake) && flags.daemonWake.includes(id);
      if (flaggedAll || flaggedThis) {
        daemonWake = true;
      } else if (isTTY && typeof ask === "function") {
        const ans = String(
          (await ask(`Enable daemon waking for ${identity.name} (${agentType})? [y/N]: `)) ?? "",
        ).trim();
        daemonWake = /^y(es)?$/i.test(ans);
      } else {
        daemonWake = false; // non-TTY default: not woken
      }
    }

    // Append as its own agents[] entry, tagged with the mapped daemon agentType
    // (offline when the backend isn't daemon-wakeable), its OWN cwds, and the resolved
    // daemonWake (explicit boolean for wakeable backends; omitted for offline).
    // Merge-safe; dedups on key; only touches the newly-added entry.
    const res = append({
      url,
      apiKey,
      agentType,
      agentUuid: identity.uuid,
      agentName: identity.name,
      ...(cwds.length ? { cwds } : {}),
      ...(daemonWake !== undefined ? { daemonWake } : {}),
    });

    // dsh-only: ALSO restore the retired dsh-credentials.sh channel by seeding
    // $DSH_HOME/.env, so the doc-mirror wrapper resolves creds when `chorus` is
    // off PATH (the npx init path). Runs regardless of the daemon.json dedup
    // result (an idempotent re-run still repairs a missing/stale .env). Only the
    // path is ever surfaced — never the key.
    let dshNote = "";
    // When the profile is persisted in $DSH_HOME/.env, dsh loads it into the session
    // env for free — so init.mjs SKIPS the manual `export CHORUS_AGENT_PROFILE=…`
    // hint for this agent (every non-dsh agent still gets the hint). Only set on a
    // successful .env write; if it failed, the hint is still shown as a fallback.
    let profileInEnv = false;
    if (isDshSelection(id)) {
      try {
        const envPath = writeDshEnv({ dshHome: resolveDshHome(env), url, apiKey, agentProfile: identity.uuid });
        dshNote = `; seeded CHORUS_URL/CHORUS_API_KEY/CHORUS_AGENT_PROFILE into ${envPath} (0600)`;
        profileInEnv = true;
      } catch (err) {
        dshNote = `; WARNING: could not seed $DSH_HOME/.env: ${err?.message ?? String(err)}`;
      }
    }

    // claude-only: ALSO write the user-global ~/.claude/settings.json `env` block so
    // INTERACTIVE Claude Code authenticates with no manual export. On a SUCCESSFUL write we
    // set settingsEnvWritten so init.mjs suppresses the manual export hint (like dsh's
    // profileInEnv). Runs regardless of the daemon.json dedup result (an idempotent re-run
    // repairs a missing/stale settings.json). The key is only written into the 0600 file.
    let claudeNote = "";
    let settingsEnvWritten = false;
    if (isClaudeSelection(id)) {
      const settingsPath = resolveClaudeSettingsPath(env);
      const newProfile = identity.uuid;
      // Cross-run REPOINT detection: the user-global env block holds ONE identity, and a
      // single run configures `claude` at most once (resolveSelection dedups ids). So a
      // DIFFERENT existing profile is a PRIOR run's identity — never overwrite it silently
      // (prompt on a TTY; WARN on non-TTY). Absent/equal → write (equal is idempotent).
      const existingProfile = readSettingsProfile(settingsPath);
      const isRepoint = existingProfile !== undefined && existingProfile !== newProfile;
      let doWrite = true;
      let declined = false;
      let repointWarn = "";
      if (isRepoint) {
        if (isTTY && typeof ask === "function") {
          const ans = String(
            (await ask(
              `Interactive Claude Code is currently configured as ${existingProfile}; ` +
                `repoint it to ${identity.name} (${newProfile})? [y/N]: `,
            )) ?? "",
          ).trim();
          if (!/^y(es)?$/i.test(ans)) {
            doWrite = false;
            declined = true;
          }
        } else {
          repointWarn = ` (WARNING: repointed interactive Claude Code from ${existingProfile} to ${newProfile})`;
        }
      }
      if (doWrite) {
        try {
          const p = writeClaudeSettings({ settingsPath, url, apiKey, agentProfile: newProfile });
          settingsEnvWritten = true;
          claudeNote = `; wrote CHORUS_URL/CHORUS_API_KEY/CHORUS_AGENT_PROFILE into ${p} (0600)${repointWarn}`;
        } catch (err) {
          // B1: profileExportHint prints only CHORUS_AGENT_PROFILE and CANNOT fix native MCP
          // (it interpolates ${CHORUS_URL}/${CHORUS_API_KEY}), and printing the key would
          // break never-echo. So emit an actionable, non-secret WARNING; the export hint is
          // still shown (settingsEnvWritten stays false) as a partial fallback.
          claudeNote =
            `; WARNING: could not write ${settingsPath} (${err?.message ?? String(err)}). ` +
            "Interactive Claude Code MCP will not connect until CHORUS_URL, CHORUS_API_KEY and " +
            `CHORUS_AGENT_PROFILE are in its env block — add them to ${settingsPath} (or export them). ` +
            "Your cho_ key is not shown here.";
        }
      } else if (declined) {
        // Declined repoint: the EXISTING settings.json identity remains, and since
        // settings.json env OVERRIDES the shell, a shell export would be ignored — so
        // direct the operator to the FILE, do not suggest exporting.
        claudeNote =
          `; left interactive Claude Code as ${existingProfile} — edit ${settingsPath} to change it ` +
          "(a shell export would be overridden by settings.json env).";
      }
      // Ambient-shell conflict heads-up: settings.json env OVERRIDES the shell, so if the
      // shell already exports a DIFFERENT identity, note it. Non-secret: compare the profile
      // UUID (primary) and the key IN MEMORY (never printed).
      const shellProfile = nonEmpty(env.CHORUS_AGENT_PROFILE);
      const shellKey = nonEmpty(env.CHORUS_API_KEY);
      if ((shellProfile && shellProfile !== newProfile) || (shellKey && shellKey !== apiKey)) {
        claudeNote +=
          "; note: your shell exports a different CHORUS_* identity — settings.json env " +
          "overrides it for interactive Claude Code";
      }
    }

    // codex-only: ALSO write the user-global ~/.codex/config.toml [shell_environment_policy].set
    // so INTERACTIVE Codex's plugin hooks + shell-tool `chorus` calls resolve identity with no
    // manual export. UNGATED — every codex agent (single- and multi-agent alike), because the
    // Codex hooks never auto-single (on-session-start.sh requires CHORUS_URL+CHORUS_API_KEY;
    // chorus-mcp-call.sh needs CHORUS_AGENT_PROFILE+CLI OR url+key). Native MCP is already
    // export-free via the literal Bearer this write leaves untouched. On a SUCCESSFUL write set
    // codexEnvWritten so init.mjs suppresses the export hint (like dsh's profileInEnv / Claude
    // Code's settingsEnvWritten). Runs regardless of the daemon.json dedup result. The key is
    // only written into the 0600 file.
    let codexNote = "";
    let codexEnvWritten = false;
    if (isCodexSelection(id)) {
      const configPath = resolveCodexConfigPath(env);
      try {
        const p = writeCodexEnv({ configPath, url, apiKey, agentProfile: identity.uuid });
        codexEnvWritten = true;
        codexNote = `; wrote CHORUS_URL/CHORUS_API_KEY/CHORUS_AGENT_PROFILE into ${p} (0600) under [shell_environment_policy].set`;
      } catch (err) {
        // Write failed (locked/unwritable, or an ambiguous inline `set` we refuse to edit).
        // Emit an actionable, non-secret WARNING; the export hint is still shown
        // (codexEnvWritten stays false). No launcher wrapper — the resolution order already
        // lives in the plugin hook wrapper.
        codexNote =
          `; WARNING: could not write ${configPath} (${err?.message ?? String(err)}). ` +
          "Interactive Codex hooks will not reach Chorus until CHORUS_URL, CHORUS_API_KEY and " +
          `CHORUS_AGENT_PROFILE are in its env — add them under [shell_environment_policy.set] in ${configPath} ` +
          "(or export them). Your cho_ key is not shown here.";
      }
    }

    // Combined side-file note + hint-suppression flags (dsh, claude, and codex are mutually
    // exclusive selection ids, so at most one note/flag is set per iteration).
    const sideNote = `${dshNote}${claudeNote}${codexNote}`;
    const hintFlags = {
      ...(profileInEnv ? { profileInEnv: true } : {}),
      ...(settingsEnvWritten ? { settingsEnvWritten: true } : {}),
      ...(codexEnvWritten ? { codexEnvWritten: true } : {}),
    };

    if (!res.ok) {
      outcomes.push(
        out(
          SKIPPED,
          `${id}: ${identity.name} (${identity.uuid}) already configured (same key) — left unchanged${sideNote}`,
          // Carry the identity so the orchestrator can print a CHORUS_AGENT_PROFILE
          // export hint even on an idempotent re-run (the agent is still configured).
          { agentUuid: identity.uuid, agentName: identity.name, ...hintFlags },
        ),
      );
      continue;
    }
    outcomes.push(
      out(
        SEEDED,
        `${id}: seeded ${identity.name} (${identity.uuid}) as ${agentType} → agents[${res.index}] in ~/.chorus/daemon.json${sideNote}`,
        // Structured identity for the completion profile-export hint (init.mjs).
        { agentUuid: identity.uuid, agentName: identity.name, ...hintFlags },
      ),
    );
  }

  return outcomes;
}

/** @type {import("../contracts.mjs").InitStep} */
export const credentialSeedStep = {
  id: STEP_ID,
  order: 10, // before plugin-install (order 20)
  scope: STEP_SCOPES.ONCE,
  run: seedCredentials,
};

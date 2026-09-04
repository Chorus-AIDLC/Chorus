// cli/credentials.mjs
// Layered resolution of the Chorus server URL + `cho_` API key for the daemon
// and login subcommands. Plain ESM, zero dependencies — ships verbatim in the
// npm package alongside chorus.mjs (see package.json `files`).
//
// Precedence (first complete pair wins):
//   1. explicit flags        --url / --api-key
//   2. environment           CHORUS_URL / CHORUS_API_KEY
//   3. login file            ~/.chorus/daemon.json   (written by `chorus login`)
//   4. plugin fallback       ~/.claude/settings.json  → .env.CHORUS_URL / .env.CHORUS_API_KEY
//
// The CC chorus plugin does NOT persist credentials to a file — it reads
// CHORUS_URL / CHORUS_API_KEY from the environment, which users configure in
// the `env` block of ~/.claude/settings.json. Tier 4 reads that block as a
// best-effort last resort (file may be absent or differently shaped — read
// defensively). Verified against the 0.10.0 plugin: bin/*.sh all read the two
// env vars; .chorus/state.json holds session state, never credentials.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Absolute path to the login file written by `chorus login`. */
export function loginFilePath() {
  const override = process.env.CHORUS_DAEMON_CONFIG_PATH?.trim();
  if (override) return resolve(override);
  return join(homedir(), ".chorus", "daemon.json");
}

/** Absolute path to the Claude Code user settings file (plugin fallback source). */
export function claudeSettingsPath() {
  const override = process.env.CHORUS_CLAUDE_SETTINGS_PATH?.trim();
  if (override) return resolve(override);
  return join(homedir(), ".claude", "settings.json");
}

/**
 * Read a JSON file, returning `null` on any error (missing / unreadable /
 * malformed). Never throws — callers treat a null as "source absent".
 * @param {string} path
 * @returns {Record<string, unknown> | null}
 */
function readJsonSafe(path) {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** A non-empty string, or undefined. Trims; empty/whitespace → undefined. */
function nonEmpty(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Read the recorded yolo acknowledgement (`yoloAckAt`) from the login file, if
 * present. Returns the ISO-8601 string, or null when the file is absent /
 * unreadable / carries no ack. Never throws (a missing ack just means "not yet
 * confirmed"). The ack lives in the same `~/.chorus/daemon.json` as the
 * credentials — there is no separate ack file (daemon-permission-mode spec).
 *
 * @param {{ readJson?: (p: string) => (Record<string, unknown>|null), loginPath?: string }} [deps]
 * @returns {string | null}
 */
export function readYoloAck(deps = {}) {
  const readJson = deps.readJson ?? readJsonSafe;
  const loginPath = deps.loginPath ?? loginFilePath();
  const file = readJson(loginPath);
  return file ? nonEmpty(file.yoloAckAt) ?? null : null;
}

/**
 * Resolve the DEFAULT url + apiKey layer (per-field, non-throwing) for the
 * multi-agent config. Unlike `resolveCredentials` (which needs a COMPLETE pair
 * and throws when none resolves), this resolves each field independently and
 * returns `undefined` for any field no source supplies. It is the "top-level
 * defaults" layer that each `agents[]` entry merges over: an agent that omits
 * `url` inherits this default `url`, an agent that omits `apiKey` inherits this
 * default `apiKey` (rarely useful, but symmetric with every other default).
 *
 * Same source order as `resolveCredentials`, applied per field:
 *   flag > env > login file (top-level) > plugin fallback.
 *
 * @param {{ url?: string, apiKey?: string }} flags
 * @param {ResolveDeps} [deps]
 * @returns {{ url: string | undefined, apiKey: string | undefined }}
 */
export function resolveCredentialDefaults(flags = {}, deps = {}) {
  const env = deps.env ?? process.env;
  const readJson = deps.readJson ?? readJsonSafe;
  const loginPath = deps.loginPath ?? loginFilePath();
  const settingsPath = deps.settingsPath ?? claudeSettingsPath();

  const file = readJson(loginPath);
  const settings = readJson(settingsPath);
  const pluginEnv =
    settings && typeof settings.env === "object" && settings.env !== null
      ? /** @type {Record<string, unknown>} */ (settings.env)
      : null;

  const pick = (flagVal, envKey, fileKey) =>
    nonEmpty(flagVal) ??
    nonEmpty(env[envKey]) ??
    (file ? nonEmpty(file[fileKey]) : undefined) ??
    (pluginEnv ? nonEmpty(pluginEnv[envKey]) : undefined);

  return {
    url: pick(flags.url, "CHORUS_URL", "url"),
    apiKey: pick(flags.apiKey, "CHORUS_API_KEY", "apiKey"),
  };
}

/**
 * @typedef {Object} ResolvedCredentials
 * @property {string} url
 * @property {string} apiKey
 * @property {"flag"|"env"|"login-file"|"plugin-fallback"} source
 */

/**
 * @typedef {Object} ResolveDeps  Injectable IO for tests (no real disk/env).
 * @property {Record<string, string|undefined>} [env]
 * @property {(path: string) => (Record<string, unknown>|null)} [readJson]
 * @property {string} [loginPath]
 * @property {string} [settingsPath]
 */

/**
 * Resolve credentials from the four layered sources, in fixed precedence.
 *
 * @param {{ url?: string, apiKey?: string }} flags  Explicit --url / --api-key.
 * @param {ResolveDeps} [deps]
 * @returns {ResolvedCredentials}
 * @throws {Error} when no source yields a complete url+apiKey pair. The message
 *   lists every source that was tried and how to supply credentials.
 */
export function resolveCredentials(flags = {}, deps = {}) {
  const env = deps.env ?? process.env;
  const readJson = deps.readJson ?? readJsonSafe;
  const loginPath = deps.loginPath ?? loginFilePath();
  const settingsPath = deps.settingsPath ?? claudeSettingsPath();

  const tried = [];

  // 1. Explicit flags
  tried.push("--url/--api-key flags");
  {
    const url = nonEmpty(flags.url);
    const apiKey = nonEmpty(flags.apiKey);
    if (url && apiKey) return { url, apiKey, source: "flag" };
  }

  // 2. Environment variables
  tried.push("CHORUS_URL / CHORUS_API_KEY environment variables");
  {
    const url = nonEmpty(env.CHORUS_URL);
    const apiKey = nonEmpty(env.CHORUS_API_KEY);
    if (url && apiKey) return { url, apiKey, source: "env" };
  }

  // 3. Login file (~/.chorus/daemon.json): the flat top-level url/apiKey, else the
  //    first agents[] entry. The flat top-level agent config is DEPRECATED — `chorus
  //    init` now writes credentials only into agents[] — so fall back to agents[0]
  //    so this single-credential resolver (install/daemon-setup gate, legacy flat
  //    daemon) still resolves from an agents[]-only daemon.json.
  tried.push(`login file (${loginPath}, run \`chorus login\`)`);
  {
    const file = readJson(loginPath);
    if (file) {
      let url = nonEmpty(file.url);
      let apiKey = nonEmpty(file.apiKey);
      if (!(url && apiKey) && Array.isArray(file.agents)) {
        const a0 = file.agents.find(
          (a) => a && typeof a === "object" && nonEmpty(a.url) && nonEmpty(a.apiKey),
        );
        if (a0) {
          url = nonEmpty(a0.url);
          apiKey = nonEmpty(a0.apiKey);
        }
      }
      if (url && apiKey) return { url, apiKey, source: "login-file" };
    }
  }

  // 4. Plugin fallback (~/.claude/settings.json → env block)
  tried.push(`Claude Code plugin config (${settingsPath} → env.CHORUS_URL/CHORUS_API_KEY)`);
  {
    const settings = readJson(settingsPath);
    const envBlock =
      settings && typeof settings.env === "object" && settings.env !== null
        ? /** @type {Record<string, unknown>} */ (settings.env)
        : null;
    if (envBlock) {
      const url = nonEmpty(envBlock.CHORUS_URL);
      const apiKey = nonEmpty(envBlock.CHORUS_API_KEY);
      if (url && apiKey) return { url, apiKey, source: "plugin-fallback" };
    }
  }

  throw new Error(
    "Could not resolve Chorus credentials (url + cho_ API key). Tried, in order:\n" +
      tried.map((t, i) => `  ${i + 1}. ${t}`).join("\n") +
      "\n\nSupply credentials with one of:\n" +
      "  • flags:   chorus daemon --url <https://...> --api-key <cho_...>\n" +
      "  • env:     CHORUS_URL=<https://...> CHORUS_API_KEY=<cho_...> chorus daemon\n" +
      "  • login:   chorus login   (persists to ~/.chorus/daemon.json)\n"
  );
}

/**
 * @typedef {Object} McpCredentials
 * @property {string} url
 * @property {string} apiKey
 * @property {string} label  Diagnostic label for the acting identity ("flag" /
 *   "env" / a `~/.chorus/daemon.json` agent name/label / the flat-resolution source).
 */

/**
 * Resolve the url + `cho_` API key AND the acting agent identity for the
 * `chorus mcp` command group. Unlike `resolveCredentials`, this understands the
 * multi-agent `agents[]` model and refuses to guess which agent to act as.
 *
 * PROFILE identity (AWS-CLI style): a caller can name WHICH agent to act as by
 * `--agent <name|uuid>` (explicit flag) or the `CHORUS_AGENT_PROFILE` env var,
 * and this resolves that agent's key from `~/.chorus/daemon.json` — the secret
 * never has to be threaded through the caller's environment. A profile matches
 * an `agents[]` entry by its `agentUuid`, `agentName`, or the back-compat
 * `label`/`name` aliases (exact). Ambiguous (matches >1 entry) → hard error.
 *
 * Precedence (owner decision: PREFER profile, fall back to url+key mode when no
 * profile resolves — the key stays written in daemon.json, url+key is the
 * fallback so the CLI-absent curl path still works):
 *   1. Explicit `--agent <name|uuid>` flag → deliberate profile selection from
 *      `agents[]`, PREFERRED over an explicit url+key pair (no match → hard error
 *      listing agents). With NO `agents[]` it rides along an explicit `--url/--api-key`
 *      pair (else the env pair) as the label, else it is a usage error.
 *   2. Explicit `--url` + `--api-key` flags (no `--agent`) → used directly
 *      (identity is explicit); a `CHORUS_AGENT_PROFILE` name rides along as the label.
 *   3. `CHORUS_AGENT_PROFILE` env → ambient profile selection from `agents[]`.
 *      A match wins over the url+key env pair; NO match falls through (the
 *      profile "doesn't exist" → url-mode fallback), an ambiguous match throws.
 *   4. `CHORUS_URL` + `CHORUS_API_KEY` env pair → used directly (url-mode
 *      fallback / legacy plugin-hook path); a profile name rides as the label.
 *   5. Exactly one agent in `agents[]` + nothing specified → that agent.
 *   6. More than one agent + nothing specified → hard error (never pick
 *      silently), listing the available agents.
 *   7. No `agents[]` → flat resolution via `resolveCredentials`.
 *
 * Each selected agent's `url`/`apiKey` merges over the top-level per-field
 * defaults (`resolveCredentialDefaults`), so an agent that omits a field
 * inherits it.
 *
 * This never imports `cli/daemon-config.mjs` (which imports THIS module) — it
 * reads `agents[]` directly to stay cycle-free; only url/apiKey/label matter for
 * MCP, so per-agent agentType/permissionMode validation is intentionally skipped.
 *
 * @param {{ url?: string, apiKey?: string, agent?: string }} flags
 * @param {ResolveDeps} [deps]
 * @returns {McpCredentials}
 * @throws {Error} on ambiguity, a missing `--agent` label, or nothing resolvable.
 */
export function resolveMcpCredentials(flags = {}, deps = {}) {
  const env = deps.env ?? process.env;
  const readJson = deps.readJson ?? readJsonSafe;
  const loginPath = deps.loginPath ?? loginFilePath();
  const flagAgent = nonEmpty(flags.agent);
  const envProfile = nonEmpty(env.CHORUS_AGENT_PROFILE);
  // The profile name a caller asked for, whatever its source — used as the
  // diagnostic label when creds ultimately come from explicit flags / the env pair.
  const wanted = flagAgent ?? envProfile;

  const envPair = () => {
    const url = nonEmpty(env.CHORUS_URL);
    const apiKey = nonEmpty(env.CHORUS_API_KEY);
    return url && apiKey ? { url, apiKey } : null;
  };
  const flagPair = () => {
    const url = nonEmpty(flags.url);
    const apiKey = nonEmpty(flags.apiKey);
    return url && apiKey ? { url, apiKey } : null;
  };

  // Read agents[] once and pre-resolve every entry (label, its match keys, and
  // its effective url/apiKey merged over the top-level per-field defaults).
  const file = readJson(loginPath);
  const agentEntries =
    file && Array.isArray(file.agents)
      ? file.agents.filter((a) => a && typeof a === "object")
      : [];
  const hasAgents = agentEntries.length > 0;
  const defaults = hasAgents ? resolveCredentialDefaults(flags, deps) : { url: undefined, apiKey: undefined };
  const labelOf = (entry, i) =>
    nonEmpty(entry.agentName) ?? nonEmpty(entry.label) ?? nonEmpty(entry.name) ?? `agents[${i}]`;
  const resolved = agentEntries.map((entry, i) => ({
    label: labelOf(entry, i),
    // A profile may name an entry by its uuid, its display name, or the
    // back-compat label/name aliases.
    keys: [entry.agentUuid, entry.agentName, entry.label, entry.name]
      .map((k) => nonEmpty(k))
      .filter((k) => k !== undefined),
    url: nonEmpty(entry.url) ?? defaults.url,
    apiKey: nonEmpty(entry.apiKey) ?? defaults.apiKey,
  }));
  const labels = resolved.map((a) => a.label).join(", ");
  const pick = (a) => {
    if (!a.url || !a.apiKey) {
      throw new Error(
        `Agent "${a.label}" in ${loginPath} is missing a url or apiKey (and no top-level default supplies it).`,
      );
    }
    return { url: a.url, apiKey: a.apiKey, label: a.label };
  };
  const matchesFor = (name) => resolved.filter((a) => a.keys.includes(name));
  const selectOrThrow = (name, source) => {
    const matches = matchesFor(name);
    if (matches.length === 1) return pick(matches[0]);
    if (matches.length > 1) {
      throw new Error(
        `${source} "${name}" is ambiguous in ${loginPath} — it matches ${matches.length} agents ` +
          `(${matches.map((m) => m.label).join(", ")}). Use the agent UUID to disambiguate.`,
      );
    }
    return null; // no match
  };

  // 1. Explicit --agent flag: a deliberate profile selection — PREFERRED over an
  //    explicit url+key flag pair (owner: "prefer profile"). With NO agents[] to
  //    match, it rides an explicit flag pair (else the env pair), using the name
  //    as the diagnostic label; with neither it is a usage error.
  if (flagAgent) {
    if (hasAgents) {
      const hit = selectOrThrow(flagAgent, "--agent");
      if (hit) return hit;
      throw new Error(`--agent "${flagAgent}" not found in ${loginPath} agents[]. Available: ${labels}.`);
    }
    const pair = flagPair() ?? envPair();
    if (pair) return { url: pair.url, apiKey: pair.apiKey, label: flagAgent };
    throw new Error(
      `--agent "${flagAgent}" was given but ${loginPath} declares no agents[]. ` +
        `Remove --agent, or configure an agents[] list.`,
    );
  }

  // 2. Explicit url+key flag pair (no --agent) — identity is explicit.
  {
    const pair = flagPair();
    if (pair) return { url: pair.url, apiKey: pair.apiKey, label: wanted ?? "flag" };
  }

  // 3. CHORUS_AGENT_PROFILE env: ambient profile selection. A match wins over the
  //    url+key env pair; a no-match falls through to url-mode (profile "doesn't
  //    exist"); an ambiguous match throws.
  if (envProfile && hasAgents) {
    const hit = selectOrThrow(envProfile, "CHORUS_AGENT_PROFILE");
    if (hit) return hit;
    // no match → fall through to the url-mode fallback below
  }

  // 4. Env pair (url-mode fallback). Carry the profile name as the label if set.
  {
    const pair = envPair();
    if (pair) return { url: pair.url, apiKey: pair.apiKey, label: wanted ?? "env" };
  }

  // 5/6. agents[] with nothing specified: auto-single, else hard error.
  if (hasAgents) {
    if (resolved.length === 1) return pick(resolved[0]);
    throw new Error(
      `Multiple agents are configured in ${loginPath} (${labels}). ` +
        `Specify which one to act as with --agent <name|uuid> or CHORUS_AGENT_PROFILE.`,
    );
  }

  // 7. No agents[] → flat resolution (throws the detailed "could not resolve" error).
  const flat = resolveCredentials(flags, deps);
  return { url: flat.url, apiKey: flat.apiKey, label: flat.source };
}

/**
 * @typedef {Object} LaunchAgent
 * @property {string|undefined} url
 * @property {string|undefined} apiKey
 * @property {string|undefined} agentUuid
 * @property {string|undefined} agentName
 * @property {string|undefined} agentType   The daemon agentType stored in daemon.json
 *   ("claude-code" | "codex" | "kiro" | "pi" | "offline" | …). The launcher maps this
 *   (or an explicit --type) to a binary.
 * @property {string} label                 Diagnostic display label (name/uuid), never the key.
 */

/**
 * Resolve WHICH configured agent to launch (`chorus agents run`), returning the
 * selected `agents[]` entry INCLUDING its `agentType` — the field the launcher
 * needs to pick a binary and which `resolveMcpCredentials` deliberately drops.
 *
 * Selection precedence (mirrors `resolveMcpCredentials`, minus the url+key env/flag
 * fallbacks — a launch always acts as a configured agent):
 *   1. explicit selector: `flags.name` (the `--name` flag) or `flags.agent`
 *      (`--agent` alias), matched against each entry's agentUuid / agentName /
 *      label / name (exact). No match → error; >1 match → ambiguity error.
 *   2. `CHORUS_AGENT_PROFILE` env, same matching.
 *   3. exactly one configured agent → that agent.
 *   4. more than one and nothing specified → error (never pick silently).
 * No `agents[]` at all → error telling the user to configure one.
 *
 * Each entry's url/apiKey merges over the top-level per-field defaults
 * (`resolveCredentialDefaults`), same as `resolveMcpCredentials`. This never
 * imports daemon-config.mjs (which imports this module) — it reads `agents[]`
 * directly to stay cycle-free.
 *
 * @param {{ name?: string, agent?: string, url?: string, apiKey?: string }} flags
 * @param {ResolveDeps} [deps]
 * @returns {LaunchAgent}
 * @throws {Error} on ambiguity, no match, or no configured agents.
 */
export function resolveLaunchAgent(flags = {}, deps = {}) {
  const env = deps.env ?? process.env;
  const readJson = deps.readJson ?? readJsonSafe;
  const loginPath = deps.loginPath ?? loginFilePath();
  const wanted = nonEmpty(flags.name) ?? nonEmpty(flags.agent) ?? nonEmpty(env.CHORUS_AGENT_PROFILE);

  const file = readJson(loginPath);
  const agentEntries =
    file && Array.isArray(file.agents)
      ? file.agents.filter((a) => a && typeof a === "object")
      : [];
  if (agentEntries.length === 0) {
    throw new Error(
      `No agents are configured in ${loginPath}. Run \`chorus agents add\` to configure one.`,
    );
  }

  const defaults = resolveCredentialDefaults(flags, deps);
  const labelOf = (entry, i) =>
    nonEmpty(entry.agentName) ?? nonEmpty(entry.label) ?? nonEmpty(entry.name) ?? `agents[${i}]`;
  const resolved = agentEntries.map((entry, i) => ({
    label: labelOf(entry, i),
    keys: [entry.agentUuid, entry.agentName, entry.label, entry.name]
      .map((k) => nonEmpty(k))
      .filter((k) => k !== undefined),
    url: nonEmpty(entry.url) ?? defaults.url,
    apiKey: nonEmpty(entry.apiKey) ?? defaults.apiKey,
    agentUuid: nonEmpty(entry.agentUuid),
    agentName: nonEmpty(entry.agentName) ?? nonEmpty(entry.name),
    agentType: nonEmpty(entry.agentType),
  }));
  const labels = resolved.map((a) => a.label).join(", ");

  let selected;
  if (wanted) {
    const matches = resolved.filter((a) => a.keys.includes(wanted));
    if (matches.length === 0) {
      throw new Error(`No configured agent matches "${wanted}" in ${loginPath}. Available: ${labels}.`);
    }
    if (matches.length > 1) {
      throw new Error(
        `"${wanted}" is ambiguous in ${loginPath} — it matches ${matches.length} agents ` +
          `(${matches.map((m) => m.label).join(", ")}). Use the agent UUID to disambiguate.`,
      );
    }
    selected = matches[0];
  } else if (resolved.length === 1) {
    selected = resolved[0];
  } else {
    throw new Error(
      `Multiple agents are configured in ${loginPath} (${labels}). ` +
        `Specify which one to launch with --name <name|uuid> or CHORUS_AGENT_PROFILE.`,
    );
  }

  return {
    url: selected.url,
    apiKey: selected.apiKey,
    agentUuid: selected.agentUuid,
    agentName: selected.agentName,
    agentType: selected.agentType,
    label: selected.label,
  };
}

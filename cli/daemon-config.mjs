// cli/daemon-config.mjs
// Layered resolution of daemon tunables that are NOT credentials (子3 —
// daemon-interrupt-resume, Tech Design "Layered config"). Mirrors the precedence
// style of cli/credentials.mjs exactly — first defined source wins:
//
//   sigintTimeoutMs:  --sigint-timeout flag
//                   > CHORUS_DAEMON_SIGINT_TIMEOUT env
//                   > ~/.chorus/daemon.json `sigintTimeoutMs`
//                   > default 10000
//
// The escalation window is how long the killer waits after SIGINT before a forceful
// tree kill. Plain ESM, zero dependencies — ships verbatim in the npm package.
// IO (env / file read) is injectable so this is unit-testable without real disk.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { loginFilePath, resolveCredentials, resolveCredentialDefaults } from "./credentials.mjs";
import { resolveAgentType, KNOWN_AGENTS } from "./daemon-agent.mjs";
import { resolvePermissionMode } from "./daemon-permission-mode.mjs";

/** Built-in default escalation window (ms) — matches the spec's 10 seconds. */
export const DEFAULT_SIGINT_TIMEOUT_MS = 10_000;

/**
 * Built-in default per-agent wake concurrency. This was the process-wide
 * hardcoded WakeQueue cap (`maxConcurrency ?? 4` in daemon.mjs) before it became
 * a per-agent, configurable value — kept at 4 so an agent that specifies no
 * `maxConcurrency` behaves exactly as the daemon did before.
 */
export const DEFAULT_MAX_CONCURRENCY = 4;

/**
 * Coerce a value to a positive finite integer of milliseconds, or undefined when it
 * is absent / not a usable number. Accepts a number or a numeric string (env vars
 * and JSON both arrive as strings/numbers). Zero and negatives are rejected (a
 * non-positive window would defeat the graceful stage), as are NaN/Infinity.
 * @param {unknown} value
 * @returns {number | undefined}
 */
function positiveIntMs(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

/**
 * Read a JSON file, returning `null` on any error (missing / unreadable /
 * malformed). Never throws — mirrors credentials.mjs readJsonSafe.
 * @param {string} path
 * @returns {Record<string, unknown> | null}
 */
function readJsonSafe(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the SIGINT-escalation timeout (ms) from the four layered sources.
 *
 * @param {{ sigintTimeout?: number|string }} [flags]  Explicit --sigint-timeout.
 * @param {{
 *   env?: Record<string, string|undefined>,
 *   readJson?: (path: string) => (Record<string, unknown>|null),
 *   loginPath?: string,
 * }} [deps]
 * @returns {number}  Always a positive integer (the default when no source applies).
 */
export function resolveSigintTimeoutMs(flags = {}, deps = {}) {
  const env = deps.env ?? process.env;
  const readJson = deps.readJson ?? readJsonSafe;
  const loginPath = deps.loginPath ?? loginFilePath();

  // 1. Explicit flag
  const fromFlag = positiveIntMs(flags.sigintTimeout);
  if (fromFlag !== undefined) return fromFlag;

  // 2. Environment variable
  const fromEnv = positiveIntMs(env.CHORUS_DAEMON_SIGINT_TIMEOUT);
  if (fromEnv !== undefined) return fromEnv;

  // 3. Login/config file (~/.chorus/daemon.json)
  const file = readJson(loginPath);
  if (file) {
    const fromFile = positiveIntMs(file.sigintTimeoutMs);
    if (fromFile !== undefined) return fromFile;
  }

  // 4. Built-in default
  return DEFAULT_SIGINT_TIMEOUT_MS;
}

// ===== Multi-path cwd set (T3 — 单 daemon 多路径引擎, FR-5/FR-8, DEC-2) =====
//
// A daemon may declare a SET of local working directories (a cwd LIST) it serves.
// Each declared path becomes one INDEPENDENT connection (own SSE self-report +
// own Waker bound to that cwd), so the same agent on the same host driving several
// paths registers as several distinct rows instead of one. This is JUST a set of
// paths: per the human's cwd⟂project correction (DEC-5) it carries NO path↔project
// binding and there is NO project→cwd routing — the daemon only declares which
// directories it serves.
//
// Layered resolution, mirroring resolveSigintTimeoutMs's precedence — first defined
// source wins (the WHOLE set comes from the first source that yields any path):
//
//   --cwd flag(s)  > CHORUS_DAEMON_CWDS env (comma/`os.delimiter`-separated)
//                  > ~/.chorus/daemon.json `cwds: [...]`
//                  > [undefined]  (single connection at the daemon's process cwd)
//
// The `[undefined]` fallback is the HARD-1 / single-path default: an unspecified
// cwd set means "serve one path, the process default" — exactly today's behavior.
// The Waker/SseListener treat an `undefined` entry as "use process.cwd()".

/** Expand a leading `~` to the home dir and resolve to an absolute path. */
export function normalizeCwd(value, home) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  let expanded = trimmed;
  if (expanded === "~") expanded = home;
  else if (expanded.startsWith("~/")) expanded = resolvePath(home, expanded.slice(2));
  // Resolve relative paths against the daemon's process cwd so the declared path is
  // always absolute (claude --resume scopes transcripts to the ABSOLUTE cwd).
  return isAbsolute(expanded) ? expanded : resolvePath(expanded);
}

/**
 * De-duplicate a list of normalized paths preserving first-seen order, dropping
 * blanks/undefined. Returns the cleaned array (possibly empty).
 * @param {Array<unknown>} list @param {string} home
 * @returns {string[]}
 */
export function cleanCwdList(list, home) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const norm = normalizeCwd(raw, home);
    if (norm === undefined || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

/**
 * Resolve the SET of working directories this daemon serves (FR-5). One entry per
 * connection the daemon will register. Each entry is an absolute path, EXCEPT the
 * single-element `[undefined]` fallback which means "serve the process default cwd"
 * (the unspecified / single-path / HARD-1 default — identical to today's behavior).
 *
 * Layered precedence (first source that yields ANY path wins for the whole set):
 *   1. flags.cwd      — a string or string[] from repeatable `--cwd` flags.
 *   2. env            — CHORUS_DAEMON_CWDS, split on the platform path delimiter or
 *                       a comma (whichever the user used; both are accepted).
 *   3. login/config   — ~/.chorus/daemon.json `cwds` (array of strings).
 *   4. default        — `[undefined]` (one connection at the process cwd).
 *
 * The declaration is purely a list of paths — it does NOT carry, store, or upload
 * any path↔project binding (DEC-5: cwd ⟂ project).
 *
 * @param {{ cwd?: string|string[] }} [flags]  Explicit `--cwd` value(s).
 * @param {{
 *   env?: Record<string, string|undefined>,
 *   readJson?: (path: string) => (Record<string, unknown>|null),
 *   loginPath?: string,
 *   home?: string,
 *   delimiter?: string,
 * }} [deps]
 * @returns {Array<string|undefined>}  A non-empty list; `[undefined]` ⇒ process cwd.
 */
export function resolveDaemonCwds(flags = {}, deps = {}) {
  const env = deps.env ?? process.env;
  const readJson = deps.readJson ?? readJsonSafe;
  const loginPath = deps.loginPath ?? loginFilePath();
  const home = deps.home ?? homedir();
  // Accept both the OS path delimiter (":" on POSIX, ";" on Windows) and a comma, so
  // CHORUS_DAEMON_CWDS=/a:/b and CHORUS_DAEMON_CWDS=/a,/b both work cross-platform.
  const delimiters = new RegExp(`[${deps.delimiter ?? ""},]|${process.platform === "win32" ? ";" : ":"}`);

  // 1. Explicit --cwd flag(s) — a string or an array (repeatable flag).
  const flagList = Array.isArray(flags.cwd)
    ? flags.cwd
    : typeof flags.cwd === "string"
      ? [flags.cwd]
      : [];
  const fromFlags = cleanCwdList(flagList, home);
  if (fromFlags.length > 0) return fromFlags;

  // 2. Environment variable (delimiter- or comma-separated).
  const envRaw = env.CHORUS_DAEMON_CWDS;
  if (typeof envRaw === "string" && envRaw.trim()) {
    const fromEnv = cleanCwdList(envRaw.split(delimiters), home);
    if (fromEnv.length > 0) return fromEnv;
  }

  // 3. Login/config file (~/.chorus/daemon.json `cwds`).
  const file = readJson(loginPath);
  if (file && Array.isArray(file.cwds)) {
    const fromFile = cleanCwdList(file.cwds, home);
    if (fromFile.length > 0) return fromFile;
  }

  // 4. Built-in default: a single connection at the daemon's process cwd. `undefined`
  //    is the "unspecified" sentinel the Waker/SseListener degrade to process.cwd()
  //    for (HARD-1 / single-path — exactly today's behavior).
  return [undefined];
}

/**
 * Resolve the host-local directory discovery allowlist. Unlike `cwds`, these
 * roots never create connections. The whole list comes from the first
 * non-empty source: flag > env > daemon.json > OS home.
 */
export function resolveBrowseRoots(flags = {}, deps = {}) {
  const env = deps.env ?? process.env;
  const readJson = deps.readJson ?? readJsonSafe;
  const loginPath = deps.loginPath ?? loginFilePath();
  const home = deps.home ?? homedir();
  const flagList = Array.isArray(flags.browseRoot)
    ? flags.browseRoot
    : typeof flags.browseRoot === "string"
      ? [flags.browseRoot]
      : [];
  const fromFlags = cleanCwdList(flagList, home);
  if (fromFlags.length) return fromFlags;

  const envRaw = env.CHORUS_DAEMON_BROWSE_ROOTS;
  if (typeof envRaw === "string" && envRaw.trim()) {
    const separator = deps.delimiter ?? (process.platform === "win32" ? ";" : ":");
    const fromEnv = cleanCwdList(
      envRaw.split(envRaw.includes(",") ? "," : separator),
      home,
    );
    if (fromEnv.length) return fromEnv;
  }

  const file = readJson(loginPath);
  const fromFile = file && Array.isArray(file.browseRoots)
    ? cleanCwdList(file.browseRoots, home)
    : [];
  return fromFile.length ? fromFile : [normalizeCwd(home, home)];
}

// ===== Multi-agent config (daemon-multi-agent — N independent agents per daemon) =====
//
// One daemon process may serve a LIST of fully-independent agents, each with its
// own credentials + working directories + backend + permission mode + concurrency.
// `resolveAgentConfigs` returns that list as `AgentConfig[]`, every field already
// merged with its default. Two shapes are supported:
//
//   1. `~/.chorus/daemon.json` has a non-empty `agents: [ … ]` array → one
//      AgentConfig per entry, each entry's fields merged OVER the top-level
//      defaults (per-agent value wins; an omitted field inherits the default).
//   2. No `agents[]` (or empty) → exactly ONE AgentConfig synthesized from the
//      existing flat resolution (resolveCredentials + resolveDaemonCwds +
//      resolveAgentType + sigint + browseRoots). This is byte-for-byte the
//      daemon's current single-agent behavior — old installs run unchanged, and
//      flags / env still resolve this single agent's fields.
//
// Validation is strict and visible: a missing apiKey, an unresolvable url, an
// unknown agentType, or an invalid permissionMode THROWS an Error naming the
// offending agent. The daemon's top-level error handler turns that into a
// non-zero exit — the resolver never silently drops or falls back to a default
// agent (matching resolveCredentials' throw-on-nothing contract).

/** A non-empty trimmed string, or undefined. */
function nonEmptyStr(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * True iff `~/.chorus/daemon.json` declares a non-empty `agents[]` with at least
 * one object entry — i.e. the daemon should run in multi-agent mode. Lets the
 * daemon pick the multi-agent startup path (bypassing the flat single-credential
 * preflight) without duplicating the file read. Never throws.
 * @param {{ readJson?: (p: string) => (Record<string, unknown>|null), loginPath?: string }} [deps]
 * @returns {boolean}
 */
export function hasConfiguredAgents(deps = {}) {
  const readJson = deps.readJson ?? readJsonSafe;
  const loginPath = deps.loginPath ?? loginFilePath();
  const file = readJson(loginPath);
  return Boolean(
    file && Array.isArray(file.agents) && file.agents.some((a) => a && typeof a === "object"),
  );
}

/**
 * Coerce to a positive finite integer (count), or undefined. Accepts number or
 * numeric string; rejects 0, negatives, NaN, Infinity. Used for maxConcurrency.
 * @param {unknown} value @returns {number | undefined}
 */
function positiveInt(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

/**
 * @typedef {Object} AgentConfig  One fully-resolved agent runtime config.
 * @property {string} url                       Chorus server URL for this agent.
 * @property {string} apiKey                    This agent's `cho_` API key.
 * @property {string} agentType                 Backend: claude-code | codex | kiro | dsh | offline.
 * @property {boolean} [daemonWake]             Wake opt-in for a wakeable backend; only
 *                                              `false` disables (absent/true ⇒ woken).
 * @property {Array<string|undefined>} cwds     Served paths (`undefined` ⇒ process cwd).
 * @property {"yolo"|"chorus"} permissionMode   Woken-agent permission posture.
 * @property {number} maxConcurrency            This agent's wake-queue cap.
 * @property {number} sigintTimeoutMs           Interrupt escalation window (ms).
 * @property {string[]} browseRoots             Directory-discovery allowlist.
 * @property {string} label                     Diagnostic label ("agent" or "agents[i]").
 * @property {string} [agentUuid]               This agent's Chorus UUID — exported to a
 *                                              woken session as CHORUS_AGENT_PROFILE so its
 *                                              hooks/skills resolve the key from daemon.json.
 * @property {string} [agentName]               This agent's Chorus display name (profile alias).
 */

/**
 * Resolve the list of agents this daemon serves. See the block comment above.
 *
 * @param {{ url?: string, apiKey?: string, agent?: string, cwd?: string|string[],
 *           browseRoot?: string|string[], sigintTimeout?: number|string,
 *           chorusOnly?: boolean, yolo?: boolean }} [flags]
 * @param {{
 *   env?: Record<string, string|undefined>,
 *   readJson?: (path: string) => (Record<string, unknown>|null),
 *   loginPath?: string,
 *   settingsPath?: string,
 *   home?: string,
 *   permissionMode?: "yolo"|"chorus",   // pre-resolved global posture (else computed)
 * }} [deps]
 * @returns {AgentConfig[]}  Non-empty list; throws on an invalid agent entry.
 */
export function resolveAgentConfigs(flags = {}, deps = {}) {
  const env = deps.env ?? process.env;
  const readJson = deps.readJson ?? readJsonSafe;
  const loginPath = deps.loginPath ?? loginFilePath();
  const home = deps.home ?? homedir();
  const file = readJson(loginPath);

  // Global default permission posture; a per-agent `permissionMode` overrides it.
  // needConfirm/hasAck is vestigial, so isTTY/hasAck do not affect the resolved mode.
  const defaultPermissionMode =
    deps.permissionMode ??
    resolvePermissionMode(flags, env, { isTTY: false, hasAck: false }).mode;

  const agentEntries =
    file && Array.isArray(file.agents)
      ? file.agents.filter((a) => a && typeof a === "object")
      : [];

  // ---- Back-compat: no agents[] → exactly one agent from flat resolution ----
  if (agentEntries.length === 0) {
    const creds = resolveCredentials(flags, deps); // throws if no complete pair (today's behavior)
    const at = resolveAgentType(flags, env, deps);
    if (!at.ok) throw new Error(at.error);
    return [
      {
        url: creds.url,
        apiKey: creds.apiKey,
        agentType: at.agent,
        cwds: resolveDaemonCwds(flags, deps),
        permissionMode: defaultPermissionMode,
        maxConcurrency: positiveInt(file?.maxConcurrency) ?? DEFAULT_MAX_CONCURRENCY,
        sigintTimeoutMs: resolveSigintTimeoutMs(flags, deps),
        browseRoots: resolveBrowseRoots(flags, deps),
        label: "agent",
        agentUuid: nonEmptyStr(file?.agentUuid),
        agentName: nonEmptyStr(file?.agentName),
      },
    ];
  }

  // ---- Multi-agent: each entry merged over the top-level defaults ----
  const credDefaults = resolveCredentialDefaults(flags, deps);
  const defaultCwds = resolveDaemonCwds(flags, deps);
  const defaultAgentType = resolveAgentType(flags, env, deps); // top-level default (may be {ok:false} if top-level `agent` is garbage)
  const defaultSigint = resolveSigintTimeoutMs(flags, deps);
  const defaultBrowseRoots = resolveBrowseRoots(flags, deps);
  const defaultMaxConcurrency = positiveInt(file?.maxConcurrency) ?? DEFAULT_MAX_CONCURRENCY;

  return agentEntries.map((entry, i) => {
    const label = nonEmptyStr(entry.label) ?? nonEmptyStr(entry.name) ?? `agents[${i}]`;

    const url = nonEmptyStr(entry.url) ?? credDefaults.url;
    const apiKey = nonEmptyStr(entry.apiKey) ?? credDefaults.apiKey;
    if (!apiKey) {
      throw new Error(`Agent ${label}: missing apiKey (no per-agent apiKey and no top-level default).`);
    }
    if (!url) {
      throw new Error(`Agent ${label}: missing/unresolvable url (no per-agent url and no top-level default).`);
    }

    // agentType: per-agent value, else the top-level default (which must itself be valid).
    let agentType;
    if (nonEmptyStr(entry.agentType)) {
      agentType = nonEmptyStr(entry.agentType);
    } else if (defaultAgentType.ok) {
      agentType = defaultAgentType.agent;
    } else {
      throw new Error(
        `Agent ${label}: no agentType and the top-level agent default is invalid (${defaultAgentType.error}).`,
      );
    }
    if (!KNOWN_AGENTS.includes(agentType)) {
      throw new Error(
        `Agent ${label}: unknown agentType "${agentType}". Accepted: ${KNOWN_AGENTS.join(", ")}.`,
      );
    }

    // permissionMode: per-agent override (yolo|chorus only), else global posture.
    let permissionMode = defaultPermissionMode;
    if (entry.permissionMode !== undefined) {
      const pm = nonEmptyStr(entry.permissionMode);
      if (pm !== "yolo" && pm !== "chorus") {
        throw new Error(
          `Agent ${label}: invalid permissionMode "${entry.permissionMode}". Accepted: yolo, chorus.`,
        );
      }
      permissionMode = pm;
    }

    // cwds: per-agent list (cleaned); an empty/blank list degrades to [undefined]
    // (serve the process cwd). Omitted → inherit the top-level default set.
    let cwds;
    if (entry.cwds !== undefined) {
      const cleaned = cleanCwdList(entry.cwds, home);
      cwds = cleaned.length ? cleaned : [undefined];
    } else {
      cwds = defaultCwds;
    }

    const maxConcurrency = positiveInt(entry.maxConcurrency) ?? defaultMaxConcurrency;
    const sigintTimeoutMs = positiveIntMs(entry.sigintTimeoutMs) ?? defaultSigint;
    const browseRoots =
      entry.browseRoots !== undefined ? cleanCwdList(entry.browseRoots, home) : defaultBrowseRoots;

    // daemonWake: per-agent opt-in for daemon waking (pass-through boolean). Only
    // `=== false` disables waking; absent (undefined) or true ⇒ woken, so agent
    // entries written before this field existed keep being woken. Orthogonal to
    // agentType (offline is never woken regardless).
    return {
      url,
      apiKey,
      agentType,
      cwds,
      permissionMode,
      maxConcurrency,
      sigintTimeoutMs,
      browseRoots,
      daemonWake: entry.daemonWake,
      label,
      agentUuid: nonEmptyStr(entry.agentUuid),
      agentName: nonEmptyStr(entry.agentName),
    };
  });
}

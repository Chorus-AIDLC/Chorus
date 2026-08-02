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
import { loginFilePath } from "./credentials.mjs";

/** Built-in default escalation window (ms) — matches the spec's 10 seconds. */
export const DEFAULT_SIGINT_TIMEOUT_MS = 10_000;

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

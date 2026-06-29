// cli/codex-session-map.mjs
// Daemon-local persistence of the Codex `anchor → thread_id` map. Codex GENERATES
// its own thread id (unlike Claude, which accepts a client-supplied --session-id),
// so to make a wake resumable across daemon restarts we record the generated id
// keyed by the Chorus session anchor (direct idea uuid, or the entity uuid for an
// ad-hoc session) and `codex exec resume <thread_id>` on the next wake.
//
// The store is a single JSON object `{ "<anchor>": "<thread_id>" }` at
// ~/.chorus/codex-sessions.json (same dir family as daemon.json). The anchor is a
// globally-unique Chorus uuid, so one flat file is safe across the daemon's
// multiple path-connections.
//
// CONTRACT: this is best-effort and MUST NEVER throw into the wake path. Any
// read/parse/write/rename failure degrades to "no mapping → next wake starts
// fresh" with a visible log (no-silent-errors). IO is injectable for tests.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

/** Absolute path to the Codex session-id map, alongside ~/.chorus/daemon.json. */
export function codexSessionMapPath() {
  return join(homedir(), ".chorus", "codex-sessions.json");
}

/** A non-empty trimmed string, or null. */
function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Read the whole map as a plain object. Missing / unreadable / malformed file →
 * `{}` (never throws). A non-object JSON value (array / scalar) is also treated
 * as empty.
 * @param {string} path
 * @param {(p: string) => string} read
 * @param {{warn(m:string):void}} logger
 * @returns {Record<string, unknown>}
 */
function readMap(path, read, logger) {
  let raw;
  try {
    raw = read(path);
  } catch (err) {
    // ENOENT is the normal "no map yet" case — silent. Other read errors warn.
    if (!(err && err.code === "ENOENT")) {
      logger.warn(`[Chorus] codex-session-map: read failed (${err}) — treating as empty`);
    }
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    logger.warn("[Chorus] codex-session-map: file is not a JSON object — treating as empty");
    return {};
  } catch (err) {
    logger.warn(`[Chorus] codex-session-map: corrupt JSON (${err}) — treating as empty`);
    return {};
  }
}

/**
 * Look up the Codex thread id recorded for `anchor`, or null when there is none
 * (no file, no entry, or a non-string entry). Never throws.
 * @param {string} anchor
 * @param {{ path?: string, read?: (p: string) => string, logger?: any }} [deps]
 * @returns {string | null}
 */
export function getThreadId(anchor, deps = {}) {
  const a = nonEmpty(anchor);
  if (!a) return null;
  const path = deps.path ?? codexSessionMapPath();
  const read = deps.read ?? ((p) => readFileSync(p, "utf8"));
  const logger = deps.logger ?? NOOP_LOGGER;
  const map = readMap(path, read, logger);
  return nonEmpty(map[a]);
}

/**
 * Record `anchor → threadId`, preserving every other entry. Atomic (temp file +
 * rename). Best-effort: a blank anchor/threadId is ignored (no write), and any
 * IO failure is logged and swallowed — it never throws into the wake path.
 * @param {string} anchor
 * @param {string} threadId
 * @param {{ path?: string, read?: (p: string) => string,
 *           write?: (p: string, c: string, o?: object) => void,
 *           mkdir?: (p: string, o?: object) => void,
 *           rename?: (from: string, to: string) => void, logger?: any }} [deps]
 * @returns {void}
 */
export function setThreadId(anchor, threadId, deps = {}) {
  const a = nonEmpty(anchor);
  const t = nonEmpty(threadId);
  if (!a || !t) return; // nothing meaningful to persist
  const path = deps.path ?? codexSessionMapPath();
  const read = deps.read ?? ((p) => readFileSync(p, "utf8"));
  const write = deps.write ?? writeFileSync;
  const mkdir = deps.mkdir ?? mkdirSync;
  const rename = deps.rename ?? renameSync;
  const logger = deps.logger ?? NOOP_LOGGER;

  try {
    const map = readMap(path, read, logger);
    map[a] = t;
    mkdir(dirname(path), { recursive: true });
    // Atomic write: temp file (0600) in the same dir, then rename over target,
    // so a crash mid-write never truncates the live map.
    const tmp = `${path}.tmp`;
    write(tmp, JSON.stringify(map, null, 2) + "\n", { mode: 0o600 });
    rename(tmp, path);
  } catch (err) {
    // Best-effort: a failed persist just means the next wake starts fresh.
    logger.warn(`[Chorus] codex-session-map: failed to persist ${a}→${t} (${err}) — wake will start fresh next time`);
  }
}

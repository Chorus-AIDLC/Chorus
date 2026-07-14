// cli/session-map.mjs
// Generic daemon-local persistence of an `anchor → session-handle` map, shared by
// the backends whose CLI GENERATES its own conversation id (Codex thread_id, Kiro
// sessionId) rather than accepting a client-supplied one. To make such a wake
// resumable across daemon restarts we record the generated handle keyed by the
// Chorus session anchor (direct idea uuid, or the entity uuid for an ad-hoc
// session) and pass it back to the CLI's resume flag on the next wake.
//
// The store is a single JSON object `{ "<anchor>": "<handle>" }` at
// ~/.chorus/<filename> (same dir family as daemon.json). The anchor is a
// globally-unique Chorus uuid, so one flat file is safe across the daemon's
// multiple path-connections.
//
// CONTRACT: this is best-effort and MUST NEVER throw into the wake path. Any
// read/parse/write/rename failure degrades to "no mapping → next wake starts
// fresh" with a visible log (no-silent-errors). IO is injectable for tests.
//
// Backends wrap this factory with their own filename + semantic export names:
//   codex-session-map.mjs → codex-sessions.json, getThreadId/setThreadId
//   kiro-session-map.mjs  → kiro-sessions.json,  getSessionId/setSessionId

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

/** A non-empty trimmed string, or null. */
function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Read the whole map as a plain object. Missing / unreadable / malformed file →
 * `{}` (never throws). A non-object JSON value (array / scalar) is also treated
 * as empty.
 * @param {string} path @param {(p: string) => string} read
 * @param {{warn(m:string):void}} logger @param {string} logPrefix
 * @returns {Record<string, unknown>}
 */
function readMap(path, read, logger, logPrefix) {
  let raw;
  try {
    raw = read(path);
  } catch (err) {
    // ENOENT is the normal "no map yet" case — silent. Other read errors warn.
    if (!(err && err.code === "ENOENT")) {
      logger.warn(`[Chorus] ${logPrefix}: read failed (${err}) — treating as empty`);
    }
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    logger.warn(`[Chorus] ${logPrefix}: file is not a JSON object — treating as empty`);
    return {};
  } catch (err) {
    logger.warn(`[Chorus] ${logPrefix}: corrupt JSON (${err}) — treating as empty`);
    return {};
  }
}

/**
 * Build a backend-specific session map bound to a `~/.chorus/<filename>` store and
 * a `logPrefix` for its warnings. Returns `{ mapPath, get, set }` — the get/set
 * signatures and their injectable-IO deps are identical to the original
 * codex-session-map so its tests pass unchanged.
 *
 * @param {{ filename: string, logPrefix: string }} config
 * @returns {{
 *   mapPath: () => string,
 *   get: (anchor: string, deps?: object) => string | null,
 *   set: (anchor: string, handle: string, deps?: object) => void,
 * }}
 */
export function createSessionMap({ filename, logPrefix }) {
  /** Absolute path to this backend's session-id map, alongside ~/.chorus/daemon.json. */
  const mapPath = () => join(homedir(), ".chorus", filename);

  /**
   * Look up the handle recorded for `anchor`, or null when there is none (no file,
   * no entry, or a non-string entry). Never throws.
   */
  const get = (anchor, deps = {}) => {
    const a = nonEmpty(anchor);
    if (!a) return null;
    const path = deps.path ?? mapPath();
    const read = deps.read ?? ((p) => readFileSync(p, "utf8"));
    const logger = deps.logger ?? NOOP_LOGGER;
    const map = readMap(path, read, logger, logPrefix);
    return nonEmpty(map[a]);
  };

  /**
   * Record `anchor → handle`, preserving every other entry. Atomic (temp file +
   * rename). Best-effort: a blank anchor/handle is ignored (no write), and any IO
   * failure is logged and swallowed — it never throws into the wake path.
   */
  const set = (anchor, handle, deps = {}) => {
    const a = nonEmpty(anchor);
    const h = nonEmpty(handle);
    if (!a || !h) return; // nothing meaningful to persist
    const path = deps.path ?? mapPath();
    const read = deps.read ?? ((p) => readFileSync(p, "utf8"));
    const write = deps.write ?? writeFileSync;
    const mkdir = deps.mkdir ?? mkdirSync;
    const rename = deps.rename ?? renameSync;
    const logger = deps.logger ?? NOOP_LOGGER;

    try {
      const map = readMap(path, read, logger, logPrefix);
      map[a] = h;
      mkdir(dirname(path), { recursive: true });
      // Atomic write: temp file (0600) in the same dir, then rename over target,
      // so a crash mid-write never truncates the live map.
      const tmp = `${path}.tmp`;
      write(tmp, JSON.stringify(map, null, 2) + "\n", { mode: 0o600 });
      rename(tmp, path);
    } catch (err) {
      // Best-effort: a failed persist just means the next wake starts fresh.
      logger.warn(`[Chorus] ${logPrefix}: failed to persist ${a}→${h} (${err}) — wake will start fresh next time`);
    }
  };

  return { mapPath, get, set };
}

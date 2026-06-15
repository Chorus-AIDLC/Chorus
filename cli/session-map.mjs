// cli/session-map.mjs
// Persistent map from a session key (root idea uuid, or a per-entity fallback
// key when there's no idea ancestor) to the Claude session id, so the daemon
// can --resume the same session across wakes for the same root idea.
//
// File: ~/.chorus/sessions.json  →  { "<key>": { sessionId, updatedAt } }
// Corruption/absence is tolerated: load() logs and starts from an empty map
// (no-silent-errors, but no crash).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

/** Default path: ~/.chorus/sessions.json */
export function sessionMapPath() {
  return join(homedir(), ".chorus", "sessions.json");
}

export class SessionMap {
  /**
   * @param {{
   *   path?: string,
   *   logger?: { info(m:string):void, warn(m:string):void, error(m:string):void },
   *   read?: (p: string) => string,
   *   write?: (p: string, c: string, o: object) => void,
   *   mkdir?: (p: string, o: object) => void,
   *   now?: () => string,
   * }} [opts]
   */
  constructor(opts = {}) {
    this.path = opts.path ?? sessionMapPath();
    this.logger = opts.logger ?? NOOP_LOGGER;
    this.read = opts.read ?? ((p) => readFileSync(p, "utf8"));
    this.write = opts.write ?? writeFileSync;
    this.mkdir = opts.mkdir ?? mkdirSync;
    // now() is injectable because Date.now/new Date are unavailable in some
    // sandboxes and to keep tests deterministic.
    this.now = opts.now ?? (() => new Date().toISOString());
    /** @type {Map<string, { sessionId: string, updatedAt: string }>} */
    this.map = new Map();
    this.#load();
  }

  /** Load the map from disk; tolerate missing/corrupt files. */
  #load() {
    let raw;
    try {
      raw = this.read(this.path);
    } catch {
      // Missing file is normal on first run — start empty, no warning noise.
      this.map = new Map();
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const [key, val] of Object.entries(parsed)) {
          if (val && typeof val.sessionId === "string") {
            this.map.set(key, { sessionId: val.sessionId, updatedAt: val.updatedAt ?? "" });
          }
        }
      }
    } catch (err) {
      this.logger.warn(
        `[Chorus] session map at ${this.path} is corrupt — starting from empty map: ${err}`
      );
      this.map = new Map();
    }
  }

  /**
   * Look up the session for a key.
   * @param {string} key  Root idea uuid (or per-entity fallback key).
   * @returns {{ sessionId: string|null, isNew: boolean }}
   *   isNew=false → caller passes --resume sessionId; isNew=true → fresh session.
   */
  resolve(key) {
    const entry = this.map.get(key);
    if (entry) return { sessionId: entry.sessionId, isNew: false };
    return { sessionId: null, isNew: true };
  }

  /**
   * Persist the session id for a key (called after a wake establishes/continues
   * a session). Writes the whole map back to disk.
   * @param {string} key @param {string} sessionId
   */
  record(key, sessionId) {
    this.map.set(key, { sessionId, updatedAt: this.now() });
    this.#persist();
  }

  #persist() {
    const obj = {};
    for (const [key, val] of this.map.entries()) obj[key] = val;
    try {
      this.mkdir(dirname(this.path), { recursive: true });
      this.write(this.path, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
    } catch (err) {
      this.logger.warn(`[Chorus] failed to persist session map to ${this.path}: ${err}`);
    }
  }
}

// cli/codex-session-map.mjs
// Daemon-local persistence of the Codex `anchor → thread_id` map. Codex GENERATES
// its own thread id (unlike Claude, which accepts a client-supplied --session-id),
// so to make a wake resumable across daemon restarts we record the generated id
// keyed by the Chorus session anchor (direct idea uuid, or the entity uuid for an
// ad-hoc session) and `codex exec resume <thread_id>` on the next wake.
//
// Thin wrapper over the generic `createSessionMap` factory (shared with the Kiro
// backend); the store is ~/.chorus/codex-sessions.json. The public API
// (getThreadId / setThreadId / codexSessionMapPath) and its injectable-IO deps are
// unchanged — see session-map.mjs for the best-effort / never-throw contract.

import { createSessionMap } from "./session-map.mjs";

const map = createSessionMap({ filename: "codex-sessions.json", logPrefix: "codex-session-map" });

/** Absolute path to the Codex session-id map, alongside ~/.chorus/daemon.json. */
export function codexSessionMapPath() {
  return map.mapPath();
}

/**
 * Look up the Codex thread id recorded for `anchor`, or null when there is none
 * (no file, no entry, or a non-string entry). Never throws.
 * @param {string} anchor
 * @param {{ path?: string, read?: (p: string) => string, logger?: any }} [deps]
 * @returns {string | null}
 */
export function getThreadId(anchor, deps = {}) {
  return map.get(anchor, deps);
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
  map.set(anchor, threadId, deps);
}

// cli/kiro-session-map.mjs
// Daemon-local persistence of the Kiro `anchor → sessionId` map. Kiro GENERATES
// its own per-cwd conversation sessionId (unlike Claude, which accepts a
// client-supplied --session-id), and the daemon works one repo cwd shared by many
// ideas — so Kiro's native "resume most recent conversation from this directory"
// would cross-contaminate ideas. Instead we record the generated sessionId keyed
// by the Chorus session anchor (direct idea uuid, or the entity uuid for an ad-hoc
// session) and `kiro-cli chat --no-interactive --resume-id <sessionId>` on the
// next wake for that anchor.
//
// Thin wrapper over the generic `createSessionMap` factory (shared with the Codex
// backend); the store is ~/.chorus/kiro-sessions.json. See session-map.mjs for the
// best-effort / never-throw contract and the injectable-IO deps.

import { createSessionMap } from "./session-map.mjs";

const map = createSessionMap({ filename: "kiro-sessions.json", logPrefix: "kiro-session-map" });

/** Absolute path to the Kiro session-id map, alongside ~/.chorus/daemon.json. */
export function kiroSessionMapPath() {
  return map.mapPath();
}

/**
 * Look up the Kiro sessionId recorded for `anchor`, or null when there is none
 * (no file, no entry, or a non-string entry). Never throws.
 * @param {string} anchor
 * @param {{ path?: string, read?: (p: string) => string, logger?: any }} [deps]
 * @returns {string | null}
 */
export function getSessionId(anchor, deps = {}) {
  return map.get(anchor, deps);
}

/**
 * Record `anchor → sessionId`, preserving every other entry. Atomic (temp file +
 * rename). Best-effort: a blank anchor/sessionId is ignored (no write), and any
 * IO failure is logged and swallowed — it never throws into the wake path.
 * @param {string} anchor
 * @param {string} sessionId
 * @param {{ path?: string, read?: (p: string) => string,
 *           write?: (p: string, c: string, o?: object) => void,
 *           mkdir?: (p: string, o?: object) => void,
 *           rename?: (from: string, to: string) => void, logger?: any }} [deps]
 * @returns {void}
 */
export function setSessionId(anchor, sessionId, deps = {}) {
  map.set(anchor, sessionId, deps);
}

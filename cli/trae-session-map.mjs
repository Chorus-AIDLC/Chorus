// cli/trae-session-map.mjs
// Daemon-local persistence of the TRAE CLI `anchor → thread_id` map, stored in
// ~/.chorus/trae-sessions.json. TRAE CLI is a Codex fork that generates its own
// App Server thread ids; keeping them in a file separate from
// codex-sessions.json guarantees a Codex thread id is never resumed on TRAE and
// the reverse. Same best-effort / never-throw contract as session-map.mjs.

import { CODEX_FAMILY } from "./codex-family.mjs";
import { familySessionMap } from "./codex-session-map.mjs";

const map = familySessionMap(CODEX_FAMILY.trae);

/** Absolute path to the TRAE CLI session-id map, alongside ~/.chorus/daemon.json. */
export function traeSessionMapPath() {
  return map.mapPath();
}

/** TRAE CLI thread id recorded for `anchor`, or null. Never throws. */
export function getThreadId(anchor, deps = {}) {
  return map.get(anchor, deps);
}

/** Record `anchor → threadId` atomically; best-effort, never throws. */
export function setThreadId(anchor, threadId, deps = {}) {
  map.set(anchor, threadId, deps);
}

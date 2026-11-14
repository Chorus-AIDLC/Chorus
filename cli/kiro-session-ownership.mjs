// cli/kiro-session-ownership.mjs
// Ownership records for Kiro sessions the daemon may resume (OpenSpec change
// cli-agent-session-sync, design D3).
//
// Kiro GENERATES its session ids and keeps every conversation of a directory in one
// shared store (~/.kiro/sessions/cli), so a bare `anchor → sessionId` map entry cannot
// prove WHO created the session — an older agent-scoped capture, another agent on the
// same host, or a hand-edited map would all look the same. KiroSpawner therefore
// refuses to resume a mapped session unless `verifySessionOwnershipFn` vouches for it.
//
// This module is that proof: a daemon-local record, written by whoever binds a Kiro
// session to a Chorus session (the `chorus agents run` Kiro sync adapter at discovery,
// and the daemon whenever it resumes an owned session), keyed by the Kiro session id:
//   ~/.chorus/kiro-session-owners.json
//   { "<kiroSessionId>": { agentUuid, anchor, sessionKey, cwd, recordedAt } }
// `verifyKiroSessionOwnership` accepts a mapped session only when its record names the
// SAME agent and the SAME Chorus anchor (and derived key), and Kiro's own metadata for
// the session still exists for the same cwd. Anything else — no record, another agent,
// another anchor, a vanished or moved session — is rejected (the wake starts fresh).
//
// CONTRACT: best-effort, never throws (mirrors session-map.mjs). IO is injectable.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { backendSessionKey } from "./backend-session-identity.mjs";

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };
export const KIRO_OWNERSHIP_FILE = "kiro-session-owners.json";

/** Absolute path of the ownership store, alongside ~/.chorus/daemon.json. */
export function kiroOwnershipPath(home = homedir()) {
  return join(home, ".chorus", KIRO_OWNERSHIP_FILE);
}

const nonEmpty = (v) => (typeof v === "string" && v.trim() ? v : null);
const sameDir = (a, b) => {
  try {
    return resolve(a) === resolve(b);
  } catch {
    return false;
  }
};

function readStore(path, read, logger) {
  let raw;
  try {
    raw = read(path);
  } catch (err) {
    if (!(err && err.code === "ENOENT")) logger.warn(`[Chorus] kiro-session-ownership: read failed (${err}) — treating as empty`);
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    /* fall through */
  }
  logger.warn("[Chorus] kiro-session-ownership: store is not a JSON object — treating as empty");
  return {};
}

/**
 * Record (or refresh) that `sessionId` belongs to `agentUuid` for Chorus `anchor`.
 * Atomic temp+rename; never throws. A record missing any identity field is ignored.
 * @param {{ sessionId: string, agentUuid: string, anchor: string, sessionKey?: string, cwd?: string }} rec
 * @param {{ path?: string, read?: (p:string)=>string, write?: Function, mkdir?: Function, rename?: Function, logger?: any, now?: () => number }} [deps]
 * @returns {boolean} true when persisted
 */
export function recordKiroSessionOwnership(rec, deps = {}) {
  const sessionId = nonEmpty(rec?.sessionId);
  const agentUuid = nonEmpty(rec?.agentUuid);
  const anchor = nonEmpty(rec?.anchor);
  if (!sessionId || !agentUuid || !anchor) return false;
  const path = deps.path ?? kiroOwnershipPath();
  const read = deps.read ?? ((p) => readFileSync(p, "utf8"));
  const write = deps.write ?? writeFileSync;
  const mkdir = deps.mkdir ?? mkdirSync;
  const rename = deps.rename ?? renameSync;
  const logger = deps.logger ?? NOOP_LOGGER;
  const now = deps.now ?? Date.now;
  try {
    const store = readStore(path, read, logger);
    store[sessionId] = {
      agentUuid,
      anchor,
      sessionKey: nonEmpty(rec.sessionKey) ?? backendSessionKey(anchor, agentUuid),
      cwd: nonEmpty(rec.cwd),
      recordedAt: new Date(now()).toISOString(),
    };
    mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    write(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
    rename(tmp, path);
    return true;
  } catch (err) {
    logger.warn(`[Chorus] kiro-session-ownership: failed to record ${sessionId} (${err})`);
    return false;
  }
}

/** The ownership record for `sessionId`, or null. Never throws. */
export function readKiroSessionOwnership(sessionId, deps = {}) {
  const id = nonEmpty(sessionId);
  if (!id) return null;
  const path = deps.path ?? kiroOwnershipPath();
  const read = deps.read ?? ((p) => readFileSync(p, "utf8"));
  const rec = readStore(path, read, deps.logger ?? NOOP_LOGGER)[id];
  return rec && typeof rec === "object" ? rec : null;
}

/**
 * KiroSpawner `verifySessionOwnershipFn`: accept `sessionId` only when it is recorded
 * as owned by the same agent for the same anchor/key, and Kiro's metadata
 * `<dir>/<sessionId>.json` still exists for the same cwd. Never throws.
 * @param {{ agentUuid: string, anchor: string, sessionKey?: string, sessionId: string, cwd?: string, dir?: string }} o
 * @param {{ path?: string, read?: (p:string)=>string, logger?: any }} [deps]
 * @returns {boolean}
 */
export function verifyKiroSessionOwnership(o, deps = {}) {
  try {
    const agentUuid = nonEmpty(o?.agentUuid);
    const anchor = nonEmpty(o?.anchor);
    const sessionId = nonEmpty(o?.sessionId);
    if (!agentUuid || !anchor || !sessionId) return false;
    const rec = readKiroSessionOwnership(sessionId, deps);
    if (!rec || rec.agentUuid !== agentUuid || rec.anchor !== anchor) return false;
    const expectedKey = nonEmpty(o.sessionKey) ?? backendSessionKey(anchor, agentUuid);
    if (rec.sessionKey !== expectedKey) return false;
    if (!o.dir) return false;
    const read = deps.read ?? ((p) => readFileSync(p, "utf8"));
    let meta;
    try {
      meta = JSON.parse(read(join(o.dir, `${sessionId}.json`)));
    } catch {
      return false; // the session vanished from Kiro's store: nothing to resume
    }
    if (!meta || typeof meta !== "object") return false;
    if (typeof meta.session_id === "string" && meta.session_id !== sessionId) return false;
    if (o.cwd && typeof meta.cwd === "string" && !sameDir(meta.cwd, o.cwd)) return false;
    if (o.cwd && typeof rec.cwd === "string" && !sameDir(rec.cwd, o.cwd)) return false;
    return true;
  } catch {
    return false;
  }
}

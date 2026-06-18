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

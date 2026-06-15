// cli/credentials.mjs
// Layered resolution of the Chorus server URL + `cho_` API key for the daemon
// and login subcommands. Plain ESM, zero dependencies — ships verbatim in the
// npm package alongside chorus.mjs (see package.json `files`).
//
// Precedence (first complete pair wins):
//   1. explicit flags        --url / --api-key
//   2. environment           CHORUS_URL / CHORUS_API_KEY
//   3. login file            ~/.chorus/daemon.json   (written by `chorus login`)
//   4. plugin fallback       ~/.claude/settings.json  → .env.CHORUS_URL / .env.CHORUS_API_KEY
//
// The CC chorus plugin does NOT persist credentials to a file — it reads
// CHORUS_URL / CHORUS_API_KEY from the environment, which users configure in
// the `env` block of ~/.claude/settings.json. Tier 4 reads that block as a
// best-effort last resort (file may be absent or differently shaped — read
// defensively). Verified against the 0.10.0 plugin: bin/*.sh all read the two
// env vars; .chorus/state.json holds session state, never credentials.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Absolute path to the login file written by `chorus login`. */
export function loginFilePath() {
  return join(homedir(), ".chorus", "daemon.json");
}

/** Absolute path to the Claude Code user settings file (plugin fallback source). */
export function claudeSettingsPath() {
  return join(homedir(), ".claude", "settings.json");
}

/**
 * Read a JSON file, returning `null` on any error (missing / unreadable /
 * malformed). Never throws — callers treat a null as "source absent".
 * @param {string} path
 * @returns {Record<string, unknown> | null}
 */
function readJsonSafe(path) {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** A non-empty string, or undefined. Trims; empty/whitespace → undefined. */
function nonEmpty(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * @typedef {Object} ResolvedCredentials
 * @property {string} url
 * @property {string} apiKey
 * @property {"flag"|"env"|"login-file"|"plugin-fallback"} source
 */

/**
 * @typedef {Object} ResolveDeps  Injectable IO for tests (no real disk/env).
 * @property {Record<string, string|undefined>} [env]
 * @property {(path: string) => (Record<string, unknown>|null)} [readJson]
 * @property {string} [loginPath]
 * @property {string} [settingsPath]
 */

/**
 * Resolve credentials from the four layered sources, in fixed precedence.
 *
 * @param {{ url?: string, apiKey?: string }} flags  Explicit --url / --api-key.
 * @param {ResolveDeps} [deps]
 * @returns {ResolvedCredentials}
 * @throws {Error} when no source yields a complete url+apiKey pair. The message
 *   lists every source that was tried and how to supply credentials.
 */
export function resolveCredentials(flags = {}, deps = {}) {
  const env = deps.env ?? process.env;
  const readJson = deps.readJson ?? readJsonSafe;
  const loginPath = deps.loginPath ?? loginFilePath();
  const settingsPath = deps.settingsPath ?? claudeSettingsPath();

  const tried = [];

  // 1. Explicit flags
  tried.push("--url/--api-key flags");
  {
    const url = nonEmpty(flags.url);
    const apiKey = nonEmpty(flags.apiKey);
    if (url && apiKey) return { url, apiKey, source: "flag" };
  }

  // 2. Environment variables
  tried.push("CHORUS_URL / CHORUS_API_KEY environment variables");
  {
    const url = nonEmpty(env.CHORUS_URL);
    const apiKey = nonEmpty(env.CHORUS_API_KEY);
    if (url && apiKey) return { url, apiKey, source: "env" };
  }

  // 3. Login file (~/.chorus/daemon.json)
  tried.push(`login file (${loginPath}, run \`chorus login\`)`);
  {
    const file = readJson(loginPath);
    if (file) {
      const url = nonEmpty(file.url);
      const apiKey = nonEmpty(file.apiKey);
      if (url && apiKey) return { url, apiKey, source: "login-file" };
    }
  }

  // 4. Plugin fallback (~/.claude/settings.json → env block)
  tried.push(`Claude Code plugin config (${settingsPath} → env.CHORUS_URL/CHORUS_API_KEY)`);
  {
    const settings = readJson(settingsPath);
    const envBlock =
      settings && typeof settings.env === "object" && settings.env !== null
        ? /** @type {Record<string, unknown>} */ (settings.env)
        : null;
    if (envBlock) {
      const url = nonEmpty(envBlock.CHORUS_URL);
      const apiKey = nonEmpty(envBlock.CHORUS_API_KEY);
      if (url && apiKey) return { url, apiKey, source: "plugin-fallback" };
    }
  }

  throw new Error(
    "Could not resolve Chorus credentials (url + cho_ API key). Tried, in order:\n" +
      tried.map((t, i) => `  ${i + 1}. ${t}`).join("\n") +
      "\n\nSupply credentials with one of:\n" +
      "  • flags:   chorus daemon --url <https://...> --api-key <cho_...>\n" +
      "  • env:     CHORUS_URL=<https://...> CHORUS_API_KEY=<cho_...> chorus daemon\n" +
      "  • login:   chorus login   (persists to ~/.chorus/daemon.json)\n"
  );
}

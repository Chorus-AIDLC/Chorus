// cli/login.mjs
// `chorus login` — validate a Chorus url + cho_ API key and persist them to
// ~/.chorus/daemon.json (0600). On validation failure, nothing is written.
// Plain ESM; the only dependency is the in-repo MCP SDK (via chorus-client).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

import { loginFilePath } from "./credentials.mjs";
import { validateAndFetchIdentity } from "./chorus-client.mjs";

/**
 * Prompt for a line of input. When `mask` is true, typed characters are not
 * echoed (used for the secret API key — cli-auth spec "interactive key entry
 * is masked").
 *
 * @param {string} query
 * @param {{ mask?: boolean, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream }} [opts]
 * @returns {Promise<string>}
 */
export function prompt(query, opts = {}) {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const mask = opts.mask ?? false;

  return new Promise((resolve) => {
    const rl = createInterface({ input, output, terminal: true });
    if (mask) {
      // Suppress echo: intercept the readline-internal write so typed chars
      // (and the key itself) never render. The prompt string still shows.
      const writeToOutput = /** @type {(s: string) => void} */ (
        rl._writeToOutput?.bind(rl)
      );
      rl._writeToOutput = (str) => {
        if (str === query || str.includes("\n") || str.includes("\r")) {
          if (writeToOutput) writeToOutput(str);
          else output.write(str);
        }
        // otherwise swallow — no echo of secret characters
      };
    }
    rl.question(query, (answer) => {
      rl.close();
      if (mask) output.write("\n");
      resolve(answer.trim());
    });
  });
}

/**
 * Field-level merge update of the login file (`~/.chorus/daemon.json`) — the
 * single read → merge → write(0600) helper every config writer routes through.
 *
 * Reads any existing file, shallow-merges `partial` over it (partial keys win,
 * every other pre-existing field is preserved), and writes the result back with
 * owner-only permissions. A shallow merge is correct because every field is a
 * scalar or a flat array (`cwds`) — there are no nested objects to deep-merge.
 *
 * The write is atomic: the JSON is written to a sibling `<path>.tmp` at 0600 and
 * then `rename()`d over the target, so a crash mid-write never truncates the
 * live file. A missing / unreadable / malformed existing file is treated as an
 * empty object (defensive parse), so a re-login still produces a valid file
 * rather than aborting on a corrupt one.
 *
 * Because writes now merge, NO field is ever silently dropped — in particular a
 * `chorus login` preserves any pre-existing `cwds` / `yoloAckAt` /
 * `sigintTimeoutMs` (daemon-config-field-merge change; supersedes the prior
 * "credential change clears the yolo acknowledgement" behavior).
 *
 * @param {Record<string, unknown>} partial  The fields to set/overwrite.
 * @param {{
 *   path?: string,
 *   read?: (p: string) => string,
 *   write?: (p: string, c: string, o: object) => void,
 *   mkdir?: (p: string, o: object) => void,
 *   rename?: (from: string, to: string) => void,
 * }} [deps]
 * @returns {string} the file path written
 */
export function updateDaemonConfig(partial, deps = {}) {
  const path = deps.path ?? loginFilePath();
  const read = deps.read ?? ((p) => readFileSync(p, "utf8"));
  const write = deps.write ?? writeFileSync;
  const mkdir = deps.mkdir ?? mkdirSync;
  const rename = deps.rename ?? renameSync;

  // Defensive read: missing / unreadable / malformed → start from empty so a
  // re-login over a corrupt file still writes a valid one (no silent abort).
  let current = {};
  try {
    const parsed = JSON.parse(read(path));
    // Only a plain object is a valid config; arrays / scalars → start fresh.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed;
  } catch {
    // treat as empty
  }

  const merged = { ...current, ...partial };
  mkdir(dirname(path), { recursive: true });
  // Atomic write: temp file (0600) in the same dir, then rename over target.
  const tmp = `${path}.tmp`;
  write(tmp, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  rename(tmp, path);
  return path;
}

/**
 * Persist credentials + identity to the login file with owner-only perms.
 *
 * Thin wrapper over {@link updateDaemonConfig}: it field-merges the given
 * credential/identity fields over any existing file, so every OTHER pre-existing
 * field (`cwds`, `yoloAckAt`, `sigintTimeoutMs`, …) is preserved across a
 * `chorus login` or a daemon-start credential completion. It no longer omits
 * `yoloAckAt` — a credential write never discards the recorded yolo ack.
 *
 * The `deps` seams (`path`, `write`, `mkdir`) are kept for callers/tests that
 * inject IO; `write` is the low-level `(path, content, opts)` writer.
 *
 * @param {{ url: string, apiKey: string, agentUuid: string, agentName: string }} data
 * @param {{ path?: string, write?: (p: string, c: string, o: object) => void, mkdir?: (p: string, o: object) => void, read?: (p: string) => string, rename?: (from: string, to: string) => void }} [deps]
 */
export function writeLoginFile(data, deps = {}) {
  return updateDaemonConfig(data, deps);
}

/**
 * Record (or refresh) the yolo acknowledgement in the login file, preserving
 * everything already on disk. Delegates to {@link updateDaemonConfig}, which
 * reads the current file, merges `yoloAckAt`, and rewrites with 0600. Used by
 * the daemon after an interactive TTY yolo confirmation — it does NOT touch
 * url/apiKey/identity.
 *
 * A TTY user whose credentials come from env / flags has no login file yet, but
 * the ack must still persist (else they'd re-confirm yolo on every start). A
 * file carrying only `yoloAckAt` is harmless — resolveCredentials simply falls
 * through it.
 *
 * @param {string} yoloAckAt  ISO-8601 timestamp of the confirmation.
 * @param {{ path?: string, read?: (p: string) => string, write?: (p: string, c: string, o: object) => void, mkdir?: (p: string, o: object) => void, rename?: (from: string, to: string) => void }} [deps]
 * @returns {string} the file path written
 */
export function recordYoloAck(yoloAckAt, deps = {}) {
  return updateDaemonConfig({ yoloAckAt }, deps);
}

/**
 * Run the login flow: collect url + key (flags or interactive), validate
 * against the server, and on success persist + echo identity. Returns an exit
 * code (0 success, non-zero failure). Never throws.
 *
 * @param {{ url?: string, apiKey?: string }} flags
 * @param {{
 *   validate?: typeof validateAndFetchIdentity,
 *   write?: typeof writeLoginFile,
 *   prompt?: typeof prompt,
 *   log?: (m: string) => void,
 *   errLog?: (m: string) => void,
 * }} [deps]
 * @returns {Promise<number>}
 */
export async function runLogin(flags = {}, deps = {}) {
  const validate = deps.validate ?? validateAndFetchIdentity;
  const write = deps.write ?? writeLoginFile;
  const ask = deps.prompt ?? prompt;
  const log = deps.log ?? ((m) => process.stdout.write(m + "\n"));
  const errLog = deps.errLog ?? ((m) => process.stderr.write(m + "\n"));

  let url = typeof flags.url === "string" && flags.url.trim() ? flags.url.trim() : "";
  let apiKey = typeof flags.apiKey === "string" && flags.apiKey.trim() ? flags.apiKey.trim() : "";

  if (!url) url = await ask("Chorus URL: ");
  if (!apiKey) apiKey = await ask("Chorus API key (cho_...): ", { mask: true });

  if (!url || !apiKey) {
    errLog("Login aborted: both a URL and an API key are required.");
    return 1;
  }

  let identity;
  try {
    identity = await validate({ url, apiKey });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errLog(`Login failed: ${msg}`);
    errLog("Credentials were NOT saved.");
    return 1;
  }

  const path = write({ url, apiKey, agentUuid: identity.uuid, agentName: identity.name });
  log(`Logged in as ${identity.name} (${identity.uuid}).`);
  log(`Credentials saved to ${path}.`);
  return 0;
}

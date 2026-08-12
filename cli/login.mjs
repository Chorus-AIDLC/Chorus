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

/** A non-empty trimmed string, or undefined. */
function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Append a new agent to `~/.chorus/daemon.json`'s `agents[]` (daemon-multi-agent),
 * via the same field-merge writer, WITHOUT overwriting any existing agent.
 *
 * Migration rule: if the file is still a flat single-agent config (top-level
 * `apiKey`, no `agents[]`), the flat fields are first folded into `agents[0]` so
 * the newly added key becomes `agents[1]` — the result is unambiguous (once
 * `agents[]` exists, the flat top-level fields serve only as defaults, never as a
 * standalone agent). Duplicate protection: if the new `apiKey` already matches an
 * existing agent (or the pre-migration flat key), nothing is written.
 *
 * @param {{ url?: string, apiKey: string, agentType?: string, agentUuid?: string, agentName?: string }} agentObj
 * @param {{ path?: string, read?: (p: string) => string, write?: (p: string, c: string, o: object) => void, mkdir?: (p: string, o: object) => void, rename?: (from: string, to: string) => void }} [deps]
 * @returns {{ ok: true, path: string, agents: object[], index: number } | { ok: false, reason: "duplicate" }}
 */
export function appendAgentConfig(agentObj, deps = {}) {
  const path = deps.path ?? loginFilePath();
  const read = deps.read ?? ((p) => readFileSync(p, "utf8"));

  let current = {};
  try {
    const parsed = JSON.parse(read(path));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed;
  } catch {
    // treat as empty
  }

  const existingAgents =
    Array.isArray(current.agents) ? current.agents.filter((a) => a && typeof a === "object") : [];

  /** @type {object[]} */
  let agents;
  if (existingAgents.length > 0) {
    agents = existingAgents.slice();
  } else if (nonEmpty(current.apiKey)) {
    // Migrate the flat single-agent config into agents[0] so the new key is agents[1].
    const flat = { apiKey: current.apiKey };
    if (nonEmpty(current.url)) flat.url = current.url;
    if (nonEmpty(current.agent)) flat.agentType = current.agent;
    if (Array.isArray(current.cwds)) flat.cwds = current.cwds;
    if (nonEmpty(current.agentName)) flat.agentName = current.agentName;
    if (nonEmpty(current.agentUuid)) flat.agentUuid = current.agentUuid;
    agents = [flat];
  } else {
    agents = [];
  }

  // Never add a duplicate: refuse if this apiKey already backs an agent (checking
  // both the agents[] entries and any pre-migration flat top-level key).
  const existingKeys = new Set(agents.map((a) => a.apiKey).filter(Boolean));
  if (nonEmpty(current.apiKey)) existingKeys.add(current.apiKey);
  if (existingKeys.has(agentObj.apiKey)) {
    return { ok: false, reason: "duplicate" };
  }

  agents.push(agentObj);
  const writtenPath = updateDaemonConfig({ agents }, deps);
  return { ok: true, path: writtenPath, agents, index: agents.length - 1 };
}

/**
 * Run the login flow: collect url + key (flags or interactive), validate
 * against the server, and on success persist + echo identity. Returns an exit
 * code (0 success, non-zero failure). Never throws.
 *
 * With `flags.add`, the validated key is APPENDED as an additional agent
 * (daemon-multi-agent) via {@link appendAgentConfig} instead of overwriting the
 * single flat credential — so one daemon can serve several agents. On an invalid
 * key, or a duplicate, nothing is written.
 *
 * @param {{ url?: string, apiKey?: string, agent?: string, add?: boolean }} flags
 * @param {{
 *   validate?: typeof validateAndFetchIdentity,
 *   write?: typeof writeLoginFile,
 *   appendAgent?: typeof appendAgentConfig,
 *   prompt?: typeof prompt,
 *   log?: (m: string) => void,
 *   errLog?: (m: string) => void,
 * }} [deps]
 * @returns {Promise<number>}
 */
export async function runLogin(flags = {}, deps = {}) {
  const validate = deps.validate ?? validateAndFetchIdentity;
  const write = deps.write ?? writeLoginFile;
  const appendAgent = deps.appendAgent ?? appendAgentConfig;
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
    errLog(flags.add ? "No agent was added." : "Credentials were NOT saved.");
    return 1;
  }

  // --add: append as an additional agent (multi-agent) instead of overwriting.
  if (flags.add) {
    const agentObj = { url, apiKey, agentUuid: identity.uuid, agentName: identity.name };
    if (nonEmpty(flags.agent)) agentObj.agentType = nonEmpty(flags.agent);
    const res = appendAgent(agentObj);
    if (!res.ok) {
      errLog(
        `Agent ${identity.name} (${identity.uuid}) is already configured (same API key) — nothing changed.`,
      );
      return 1;
    }
    log(`Added agent ${identity.name} (${identity.uuid}) as agents[${res.index}] in ${res.path}.`);
    log(`This daemon now serves ${res.agents.length} agent(s).`);
    return 0;
  }

  const path = write({ url, apiKey, agentUuid: identity.uuid, agentName: identity.name });
  log(`Logged in as ${identity.name} (${identity.uuid}).`);
  log(`Credentials saved to ${path}.`);
  return 0;
}

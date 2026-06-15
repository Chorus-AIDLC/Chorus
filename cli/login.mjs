// cli/login.mjs
// `chorus login` — validate a Chorus url + cho_ API key and persist them to
// ~/.chorus/daemon.json (0600). On validation failure, nothing is written.
// Plain ESM; the only dependency is the in-repo MCP SDK (via chorus-client).

import { mkdirSync, writeFileSync } from "node:fs";
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
 * Persist credentials + identity to the login file with owner-only perms.
 * @param {{ url: string, apiKey: string, agentUuid: string, agentName: string }} data
 * @param {{ path?: string, write?: (p: string, c: string, o: object) => void, mkdir?: (p: string, o: object) => void }} [deps]
 */
export function writeLoginFile(data, deps = {}) {
  const path = deps.path ?? loginFilePath();
  const write = deps.write ?? writeFileSync;
  const mkdir = deps.mkdir ?? mkdirSync;
  mkdir(dirname(path), { recursive: true });
  write(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  return path;
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

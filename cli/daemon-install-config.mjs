// cli/daemon-install-config.mjs
// The `chorus daemon install` pre-install config phase (fix-daemon-install-config,
// idea d7592c96). Two pure, dependency-injected helpers that run BEFORE the
// service unit is written, so a boot-time daemon in systemd/launchd's CLEAN
// environment can always authenticate and knows which working directories to
// serve:
//
//   resolveInstallCredentials — resolve (flags>env>daemon.json>plugin) → persist
//     into ~/.chorus/daemon.json → validate against the server → abort (write
//     nothing) if creds cannot be obtained or the key is invalid. This is the
//     crux of the fix: a systemd --user unit does NOT inherit the operator's
//     shell-exported CHORUS_URL/CHORUS_API_KEY, so the creds must live in the
//     0600 login file the clean boot env reads.
//
//   resolveInstallCwds — determine the served working-directory set and persist
//     it to daemon.json `cwds` (the single source of truth; the unit carries no
//     --cwd — see cli/daemon-service.mjs buildServiceArgs). Prompts an interactive
//     add-loop only when nothing is configured and stdin is a TTY.
//
// All IO (resolve / validate / persist / prompt / readJson / env / cwd) is
// injected so the helpers unit-test without real disk, network, or TTY — matching
// the style of cli/credentials.mjs and cli/daemon-config.mjs.

import { homedir } from "node:os";
import { resolveCredentials, loginFilePath } from "./credentials.mjs";
import { updateDaemonConfig, prompt as defaultPrompt } from "./login.mjs";
import { validateAndFetchIdentity } from "./chorus-client.mjs";
import { normalizeCwd, cleanCwdList } from "./daemon-config.mjs";
import { readFileSync } from "node:fs";

/** A non-empty trimmed string, or undefined. */
function nonEmpty(value) {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

/** Read a JSON file, returning null on any error. Mirrors credentials.mjs. */
function readJsonSafe(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Credential preflight for `chorus daemon install`. Resolves credentials, persists
 * them (with the fetched identity) into ~/.chorus/daemon.json, and validates the
 * key against the server — all BEFORE the caller writes any service unit.
 *
 * Returns `{ ok: true, creds, identity }` on success, or `{ ok: false }` when the
 * install must abort (no unit should be written). Never throws.
 *
 * Behavior (elaboration Q1/Q2/Q8/Q9):
 *   - Resolve via resolveCredentials (flags > env > daemon.json > plugin).
 *   - Unresolved + TTY + !skip → prompt login-style (masked key).
 *   - Unresolved + (skip || !TTY) → abort with the multi-source hint (no prompt).
 *   - ALWAYS validate the resolved/entered key; abort on failure.
 *   - On success persist { url, apiKey, agentUuid, agentName } via the 0600
 *     field-merge writer (preserves cwds / yoloAckAt / sigintTimeoutMs).
 *
 * @param {{ url?: string, apiKey?: string }} flags
 * @param {Record<string,string|undefined>} env
 * @param {{
 *   isTTY?: boolean, skip?: boolean,
 *   resolve?: typeof resolveCredentials,
 *   validate?: typeof validateAndFetchIdentity,
 *   writeConfig?: (partial: Record<string, unknown>) => string,
 *   prompt?: typeof defaultPrompt,
 *   log?: (m: string) => void,
 *   errLog?: (m: string) => void,
 * }} [opts]
 * @returns {Promise<{ ok: true, creds: {url:string,apiKey:string}, identity: {uuid:string,name:string} } | { ok: false }>}
 */
export async function resolveInstallCredentials(flags = {}, env = {}, opts = {}) {
  const isTTY = opts.isTTY ?? false;
  const skip = opts.skip ?? false;
  const resolve = opts.resolve ?? resolveCredentials;
  const validate = opts.validate ?? validateAndFetchIdentity;
  const writeConfig = opts.writeConfig ?? updateDaemonConfig;
  const ask = opts.prompt ?? defaultPrompt;
  const log = opts.log ?? (() => {});
  const errLog = opts.errLog ?? (() => {});

  let url;
  let apiKey;

  // 1. Try the layered resolver. It THROWS (does not return null) when no source
  //    yields a complete pair — catch it and decide prompt vs abort.
  try {
    const resolved = resolve(flags, { env });
    url = resolved.url;
    apiKey = resolved.apiKey;
    log(`[Chorus] credentials resolved from: ${resolved.source}`);
  } catch (err) {
    const hint = err instanceof Error ? err.message : String(err);
    if (!isTTY || skip) {
      // No way (or no permission) to prompt — abort with the actionable hint
      // rather than writing a unit that would crash-loop at boot.
      errLog(hint);
      return { ok: false };
    }
    // TTY + interactive: complete credentials login-style (masked key).
    log("[Chorus] no credentials found — configuring them now (saved for the boot service).");
    url = nonEmpty(await ask("Chorus URL: "));
    apiKey = nonEmpty(await ask("Chorus API key (cho_...): ", { mask: true }));
    if (!url || !apiKey) {
      errLog("[Chorus] both a URL and an API key are required — aborting install.");
      return { ok: false };
    }
  }

  // 2. ALWAYS validate against the server before writing anything (Q2/Q9) — even
  //    in skip mode. A bad/expired key fails the install instead of at boot.
  let identity;
  try {
    identity = await validate({ url, apiKey });
  } catch (err) {
    errLog(`[Chorus] credential validation failed: ${err instanceof Error ? err.message : String(err)}`);
    errLog("[Chorus] credentials were NOT saved and no service was installed.");
    return { ok: false };
  }

  // 3. Persist into the 0600 login file so the clean boot env can read it. The
  //    field-merge writer preserves cwds / yoloAckAt / sigintTimeoutMs.
  writeConfig({ url, apiKey, agentUuid: identity.uuid, agentName: identity.name });
  log(`[Chorus] credentials saved for ${identity.name} (${identity.uuid}).`);
  return { ok: true, creds: { url, apiKey }, identity };
}

/**
 * Determine the set of working directories the daemon serves and persist it to
 * ~/.chorus/daemon.json `cwds` (the single source of truth — the unit carries no
 * --cwd). Prompts an interactive add-loop only when nothing is configured and
 * stdin is a TTY (and skip is false).
 *
 * "Configured" ⇔ a `--cwd` flag was passed OR daemon.json already has a non-empty
 * `cwds` array. Configured, or skip/non-TTY, uses that set (or the process cwd
 * default) with no prompt.
 *
 * Returns `{ cwds: string[] }` — the normalized, de-duplicated set that was
 * persisted. Never throws.
 *
 * @param {{ cwd?: string[] }} flags
 * @param {{
 *   isTTY?: boolean, skip?: boolean,
 *   readJson?: (path: string) => (Record<string, unknown>|null),
 *   loginPath?: string,
 *   writeConfig?: (partial: Record<string, unknown>) => string,
 *   prompt?: typeof defaultPrompt,
 *   home?: string,
 *   processCwd?: string,
 *   log?: (m: string) => void,
 * }} [opts]
 * @returns {Promise<{ cwds: string[] }>}
 */
export async function resolveInstallCwds(flags = {}, opts = {}) {
  const isTTY = opts.isTTY ?? false;
  const skip = opts.skip ?? false;
  const readJson = opts.readJson ?? readJsonSafe;
  const loginPath = opts.loginPath ?? loginFilePath();
  const writeConfig = opts.writeConfig ?? updateDaemonConfig;
  const ask = opts.prompt ?? defaultPrompt;
  const home = opts.home ?? homedir();
  const processCwd = opts.processCwd ?? process.cwd();
  const log = opts.log ?? (() => {});

  // 1. Explicit --cwd flag(s) → configured; normalize + dedup, no prompt.
  const flagList = Array.isArray(flags.cwd) ? flags.cwd : typeof flags.cwd === "string" ? [flags.cwd] : [];
  const fromFlags = cleanCwdList(flagList, home);
  if (fromFlags.length > 0) {
    writeConfig({ cwds: fromFlags });
    return { cwds: fromFlags };
  }

  // 2. Existing daemon.json `cwds` → configured; use as-is (re-persist is a no-op
  //    merge, so we skip the write and just return them).
  const file = readJson(loginPath);
  const fromFile = file && Array.isArray(file.cwds) ? cleanCwdList(file.cwds, home) : [];
  if (fromFile.length > 0) {
    return { cwds: fromFile };
  }

  // 3. Unconfigured. On a non-TTY or in skip mode, fall back to the process cwd
  //    default with no prompt.
  const defaultCwd = normalizeCwd(processCwd, home);
  if (!isTTY || skip) {
    const cwds = defaultCwd ? [defaultCwd] : [];
    if (cwds.length > 0) writeConfig({ cwds });
    return { cwds };
  }

  // 4. Unconfigured + TTY + !skip → interactive add-loop. Pre-seed the current
  //    directory as the suggested first entry (Enter accepts it), then keep
  //    prompting until a blank line ends the loop.
  const collected = [];
  log(`[Chorus] Configure the working directories this daemon serves.`);
  const first = nonEmpty(await ask(`Working directory [${defaultCwd}] (Enter to accept the default): `));
  collected.push(first ?? defaultCwd);
  // subsequent adds
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const next = nonEmpty(await ask("Add another working directory (blank to finish): "));
    if (!next) break;
    collected.push(next);
  }
  const cwds = cleanCwdList(collected, home);
  const finalCwds = cwds.length > 0 ? cwds : defaultCwd ? [defaultCwd] : [];
  if (finalCwds.length > 0) writeConfig({ cwds: finalCwds });
  return { cwds: finalCwds };
}

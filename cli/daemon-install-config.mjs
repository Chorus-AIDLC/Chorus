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
import { updateDaemonConfig, appendAgentConfig, prompt as defaultPrompt } from "./login.mjs";
import { validateAndFetchIdentity } from "./chorus-client.mjs";
import { normalizeCwd, cleanCwdList } from "./daemon-config.mjs";
import { KNOWN_AGENTS, DEFAULT_AGENT } from "./daemon-agent.mjs";
import { agentNotFoundWarningLine } from "./daemon-banner.mjs";
import { resolveClaudePath } from "./claude-spawner.mjs";
import { resolveCodexPath } from "./codex-spawner.mjs";
import { resolveDshPath } from "./dsh-spawner.mjs";
import { resolveKiroPath } from "./kiro-spawner.mjs";
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

  // Multi-agent (daemon-multi-agent): with `--add` on a TTY, offer to add more
  // agents in the same run. Each additional key is validated then APPENDED to
  // agents[] (the first agent above is folded into agents[0] on the first
  // append). Opt-in via --add so a plain install prompts for nothing extra;
  // never runs on a non-TTY / --yes / skip run. Hand-editing daemon.json remains
  // fully supported regardless.
  if (isTTY && !skip && flags.add === true) {
    const appendAgent = opts.appendAgent ?? appendAgentConfig;
    // Bound the loop so a stuck/looping prompt can never spin forever.
    for (let added = 0; added < 32; added += 1) {
      const more = nonEmpty(await ask("Add another agent? [y/N]: "));
      if (!more || !/^y(es)?$/i.test(more)) break;
      const u = nonEmpty(await ask("  Chorus URL: "));
      const k = nonEmpty(await ask("  Chorus API key (cho_...): ", { mask: true }));
      if (!u || !k) {
        errLog("[Chorus] both a URL and an API key are required — skipping this agent.");
        continue;
      }
      let id;
      try {
        id = await validate({ url: u, apiKey: k });
      } catch (err) {
        errLog(
          `[Chorus] validation failed: ${err instanceof Error ? err.message : String(err)} — this agent was NOT added.`,
        );
        continue;
      }
      const res = appendAgent({ url: u, apiKey: k, agentUuid: id.uuid, agentName: id.name });
      if (!res.ok) {
        errLog(`[Chorus] agent ${id.name} (${id.uuid}) is already configured — skipping.`);
        continue;
      }
      log(`[Chorus] added agent ${id.name} (${id.uuid}) — this daemon now serves ${res.agents.length} agents.`);
    }
  }

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

/** Persist explicit install-time browse roots without coupling them to `cwds`. */
export async function resolveInstallBrowseRoots(flags = {}, opts = {}) {
  const readJson = opts.readJson ?? readJsonSafe;
  const loginPath = opts.loginPath ?? loginFilePath();
  const writeConfig = opts.writeConfig ?? updateDaemonConfig;
  const home = opts.home ?? homedir();
  const flagList = Array.isArray(flags.browseRoot)
    ? flags.browseRoot
    : typeof flags.browseRoot === "string"
      ? [flags.browseRoot]
      : [];
  const explicit = cleanCwdList(flagList, home);
  if (explicit.length) {
    writeConfig({ browseRoots: explicit });
    return { browseRoots: explicit };
  }
  const file = readJson(loginPath);
  const stored = file && Array.isArray(file.browseRoots)
    ? cleanCwdList(file.browseRoots, home)
    : [];
  if (stored.length) return { browseRoots: stored };
  const browseRoots = [normalizeCwd(home, home)];
  writeConfig({ browseRoots });
  return { browseRoots };
}

/**
 * The interactive agent-backend menu. Order mirrors KNOWN_AGENTS with claude-code
 * first (it is the default). Kept beside the resolver so the numbered prompt and
 * the accepted values never drift.
 */
const AGENT_MENU = [
  { value: "claude-code", label: "Claude Code (default)" },
  { value: "codex", label: "Codex CLI" },
  { value: "kiro", label: "Kiro CLI" },
  // NOTE: the dsh JSON-RPC daemon backend is temporarily de-advertised (offline).
  // The code path (probeAgentCli/resolveDshPath, spawner-select, dsh-spawner) is
  // kept dormant — re-add this menu entry to bring it back online. See CONNECT_DSH.
];

/** Probe the selected backend's CLI on PATH. Returns the resolved path or null.
 * Injectable per backend so the check is testable without a real PATH. */
function probeAgentCli(agent, probes = {}) {
  const findClaude = probes.resolveClaudePath ?? resolveClaudePath;
  const findCodex = probes.resolveCodexPath ?? resolveCodexPath;
  const findDsh = probes.resolveDshPath ?? resolveDshPath;
  const findKiro = probes.resolveKiroPath ?? resolveKiroPath;
  if (agent === "codex") return findCodex();
  if (agent === "kiro") return findKiro();
  if (agent === "dsh") return findDsh();
  return findClaude();
}

/**
 * Determine which local agent backend the installed daemon wakes and persist it
 * to ~/.chorus/daemon.json `agent` (the single source of truth — the unit carries
 * no --agent, exactly like `cwds`). AFTER resolving, probe the selected backend's
 * CLI on PATH and warn (non-fatal) when it is missing, so the operator learns at
 * install time rather than when the first wake fails.
 *
 * Resolution (first defined source wins):
 *   1. --agent flag        — the operator's explicit choice.
 *   2. CHORUS_AGENT env     — matches the daemon's own resolution precedence.
 *   3. existing daemon.json `agent` — a prior valid choice is kept (re-install is
 *      idempotent and does not re-prompt); an invalid stored value is ignored.
 *   4. TTY + !skip         — interactive numbered menu (Enter = claude-code default).
 *   5. non-TTY / skip      — DEFAULT_AGENT (claude-code), persisted so the config
 *      is explicit about the backend the boot service runs.
 *
 * Never fails: --agent / CHORUS_AGENT are already validated upstream by
 * resolveAgentType (runDaemon rejects an unknown value before dispatch), the menu
 * is constrained to KNOWN_AGENTS, and default/stored-invalid fall back to
 * claude-code. Returns the resolved `{ agent, cliPath, cliFound }`. Never throws.
 *
 * @param {{ agent?: string }} flags
 * @param {Record<string, string|undefined>} [env]
 * @param {{
 *   isTTY?: boolean, skip?: boolean,
 *   readJson?: (path: string) => (Record<string, unknown>|null),
 *   loginPath?: string,
 *   writeConfig?: (partial: Record<string, unknown>) => string,
 *   prompt?: typeof defaultPrompt,
 *   probes?: { resolveClaudePath?: Function, resolveCodexPath?: Function, resolveKiroPath?: Function, resolveDshPath?: Function },
 *   log?: (m: string) => void,
 *   errLog?: (m: string) => void,
 * }} [opts]
 * @returns {Promise<{ agent: string, cliPath: string|null, cliFound: boolean }>}
 */
export async function resolveInstallAgent(flags = {}, env = {}, opts = {}) {
  const isTTY = opts.isTTY ?? false;
  const skip = opts.skip ?? false;
  const readJson = opts.readJson ?? readJsonSafe;
  const loginPath = opts.loginPath ?? loginFilePath();
  const writeConfig = opts.writeConfig ?? updateDaemonConfig;
  const ask = opts.prompt ?? defaultPrompt;
  const log = opts.log ?? (() => {});
  const errLog = opts.errLog ?? (() => {});

  // Only a KNOWN backend is ever accepted; anything else is treated as absent.
  const known = (v) => (v && KNOWN_AGENTS.includes(v) ? v : undefined);

  let agent;
  let persist = true; // write unless we reuse an already-stored value (no-op)

  // 1/2. Explicit --agent flag or CHORUS_AGENT env (both pre-validated upstream).
  agent = known(nonEmpty(flags.agent)) ?? known(nonEmpty(env.CHORUS_AGENT));

  // 3. Existing daemon.json `agent` — a prior valid choice is authoritative; keep
  //    it and do not re-prompt (re-install stays idempotent). Skip the re-write.
  if (!agent) {
    const file = readJson(loginPath);
    const stored = known(file ? nonEmpty(file.agent) : undefined);
    if (stored) {
      agent = stored;
      persist = false; // already on disk — no-op write avoided
    }
  }

  // 4. Interactive numbered menu on a TTY (Enter accepts the claude-code default).
  if (!agent && isTTY && !skip) {
    log("[Chorus] Which local agent backend should this daemon wake?");
    for (let i = 0; i < AGENT_MENU.length; i += 1) {
      log(`[Chorus]   ${i + 1}) ${AGENT_MENU[i].label}`);
    }
    const answer = nonEmpty(await ask(`Select [1-${AGENT_MENU.length}] (Enter for 1): `));
    if (!answer) {
      agent = DEFAULT_AGENT;
    } else {
      const n = Number(answer);
      const byNumber = Number.isInteger(n) && n >= 1 && n <= AGENT_MENU.length ? AGENT_MENU[n - 1].value : undefined;
      // Also accept the value typed by name (e.g. "codex") for muscle memory.
      agent = byNumber ?? known(answer) ?? DEFAULT_AGENT;
    }
  }

  // 5. Non-TTY / skip with nothing configured → the default, persisted so the boot
  //    service config is explicit about the backend it runs.
  if (!agent) agent = DEFAULT_AGENT;

  if (persist) writeConfig({ agent });

  // Probe the selected backend's CLI (non-fatal). A missing binary warns loudly so
  // the operator fixes PATH before the first wake, but never blocks the install.
  const cliPath = probeAgentCli(agent, opts.probes);
  const cliFound = cliPath !== null;
  if (cliFound) {
    log(`[Chorus] agent backend: ${agent} (found CLI at ${cliPath}).`);
  } else {
    log(`[Chorus] agent backend: ${agent}.`);
    errLog(`[Chorus] ${agentNotFoundWarningLine(agent)}`);
  }

  return { agent, cliPath, cliFound };
}

// cli/init/steps/credential-seed.mjs
// The `once`-scoped step that captures Chorus credentials for `chorus init` and
// seeds them into the centralized daemon config (~/.chorus/daemon.json). It loops
// the init SELECTION (ctx.selection) and captures ONE Chorus key per selected
// agent, writing each as its own `agents[]` entry tagged with the daemon agentType
// its adapter maps to (cli/init/agent-type-map.mjs — claude→claude-code, codex,
// kiro, everything else→offline). This is how one `chorus init` run wires several
// agents into a single daemon at once (daemon-multi-agent).
//
// It reuses the existing, tested credential plumbing:
//   - validateAndFetchIdentity (cli/chorus-client.mjs) to validate each key
//   - appendAgentConfig (cli/login.mjs) to APPEND each validated agent to
//     `agents[]` without disturbing any other agent (migration + dedup handled
//     there), all through the MERGE-SAFE updateDaemonConfig writer that preserves
//     yoloAckAt / cwds / sigintTimeoutMs.
//
// It writes credentials ONLY into `agents[]` — the flat top-level url/apiKey
// (+ identity) agent config is DEPRECATED and is no longer written here (writing
// both duplicated the first agent: once flat, once in agents[]). Single-credential
// consumers still resolve fine: `resolveCredentials` (cli/credentials.mjs) falls
// back to `agents[0]` when the flat pair is absent, and the multi-agent resolver
// reads `agents[]` directly.
//
// dsh EXCEPTION — a SECOND credential sink: when a selected agent is DeepSeek
// Harness (`dsh`), this step ALSO seeds CHORUS_URL + CHORUS_API_KEY +
// CHORUS_AGENT_PROFILE into `$DSH_HOME/.env` (see writeDshCredentialsEnv). That
// file is dsh's ESTABLISHED
// credential channel (formerly written by the now-retired public/dsh-credentials.sh):
// dsh scrubs credential-shaped env from tool subprocesses, so the dsh doc-mirror
// wrapper (packages/chorus-dsh/bin/chorus-mcp-call.mjs) reads it via node:util
// parseEnv when the `chorus` CLI is absent from PATH. daemon.json alone does NOT
// reach that wrapper, hence the dual write. It is dsh-ONLY — no other agent gets
// a .env — and is NOT a general per-agent secret mechanism.
//
// Key handling: keys are validated then written 0600 (via updateDaemonConfig) and
// never echoed. A subsequent selected agent is NEVER given the first agent's key —
// on a non-TTY where its key can't be captured, the agent is REPORTED as still
// needing one rather than silently reusing an identity.
//
// Runs BEFORE plugin-install (order 10 < 20) so a machine is authenticated before
// its agents are wired.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { STEP_SCOPES, OUTCOME_ACTIONS } from "../contracts.mjs";
import {
  prompt as defaultPrompt,
  appendAgentConfig as defaultAppendAgentConfig,
} from "../../login.mjs";
import { resolveInstallCwds as defaultResolveInstallCwds } from "../../daemon-install-config.mjs";
import { validateAndFetchIdentity } from "../../chorus-client.mjs";
import { agentTypeForSelection, isWakeableAgentType } from "../agent-type-map.mjs";

const STEP_ID = "credential-seed";
const { SEEDED, SKIPPED, FAILED } = OUTCOME_ACTIONS;
const out = (action, detail, extra) => ({ stepId: STEP_ID, action, detail, ...(extra ?? {}) });

/** A non-empty trimmed string, or undefined. */
function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Whether an init selection id is the DeepSeek Harness (dsh). dsh needs a SECOND
 * credential sink beyond ~/.chorus/daemon.json — see {@link writeDshCredentialsEnv}.
 * We gate on the selection id, NOT the daemon agentType: dsh maps to the shared
 * "offline" agentType (agent-type-map.mjs) alongside opencode/openclaw/pi, so the
 * agentType cannot single dsh out. The id can.
 * @param {string} id
 */
function isDshSelection(id) {
  return id === "dsh";
}

/**
 * Resolve $DSH_HOME the same way dsh (and the retired public/dsh-credentials.sh)
 * did: `env.DSH_HOME` trimmed if set, else `~/.dsh`.
 * @param {Record<string, string | undefined>} env
 */
function resolveDshHome(env) {
  return nonEmpty(env.DSH_HOME) ?? join(homedir(), ".dsh");
}

/**
 * Merge-preserving upsert of CHORUS_URL + CHORUS_API_KEY into `$DSH_HOME/.env`,
 * faithfully taking over what the RETIRED public/dsh-credentials.sh used to write.
 *
 * This is dsh's ESTABLISHED credential channel — NOT a new general per-agent
 * secret write. dsh scrubs credential-shaped variables from tool subprocesses, so
 * its doc-mirror wrapper (packages/chorus-dsh/bin/chorus-mcp-call.mjs) reads the
 * credential keys (CHORUS_URL / CHORUS_API_KEY) from `$DSH_HOME/.env` via node:util
 * `parseEnv` whenever the `chorus` CLI is absent from PATH (e.g. invoked via `npx`
 * rather than the documented `npm install -g @chorus-aidlc/chorus@0.17.0`
 * global-install path). Only a `dsh` selection ever reaches this writer; every
 * other agent gets no .env.
 *
 * CHORUS_AGENT_PROFILE (the agent's UUID) is written here too, but for a DIFFERENT
 * reason than the credentials: it is NOT credential-shaped, so dsh does NOT scrub
 * it — dsh loads `$DSH_HOME/.env` into the session, and the profile reaches tools
 * (including the wrapper) directly on `process.env`. Persisting it here is what lets
 * `chorus agents add` skip the manual `export CHORUS_AGENT_PROFILE=…` hint for dsh
 * (init.mjs profileExportHint), and pins WHICH agent dsh acts as when several are
 * configured (the wrapper then delegates `chorus mcp call --agent <profile>`).
 *
 * Behavior (mirrors the old shell writer):
 *   - Preserves every unrelated line verbatim.
 *   - Upserts CHORUS_URL / CHORUS_API_KEY, plus CHORUS_AGENT_PROFILE when provided
 *     (replacing an existing line in place — with or without an `export ` prefix,
 *     and collapsing any duplicates — else appending). Idempotent: a re-run with
 *     the same values reproduces the file.
 *   - Creates `$DSH_HOME` + the file if absent. Atomic write (temp + rename) at
 *     mode 0600.
 *
 * The secret is only ever written into the 0600 file — never argv, never a log.
 * (The profile is a UUID, not a secret.)
 *
 * @param {{ dshHome: string, url: string, apiKey: string, agentProfile?: string }} args
 * @param {{
 *   read?: (p: string) => string,
 *   write?: (p: string, c: string, o: object) => void,
 *   mkdir?: (p: string, o: object) => void,
 *   rename?: (from: string, to: string) => void,
 * }} [deps]
 * @returns {string} the .env path written
 */
export function writeDshCredentialsEnv({ dshHome, url, apiKey, agentProfile }, deps = {}) {
  const read = deps.read ?? ((p) => readFileSync(p, "utf8"));
  const write = deps.write ?? writeFileSync;
  const mkdir = deps.mkdir ?? mkdirSync;
  const rename = deps.rename ?? renameSync;

  const envPath = join(dshHome, ".env");

  let existing = "";
  try {
    existing = read(envPath);
  } catch {
    existing = ""; // no file yet — start fresh
  }

  // Managed keys: the two credential keys always; CHORUS_AGENT_PROFILE (the agent's
  // UUID) when one was resolved. Only managed keys are rewritten — any other line
  // (including a stale CHORUS_AGENT_PROFILE when none is provided this run) is kept
  // verbatim, so the unrelated-line contract holds.
  const upserts = { CHORUS_URL: url, CHORUS_API_KEY: apiKey };
  if (nonEmpty(agentProfile)) upserts.CHORUS_AGENT_PROFILE = agentProfile.trim();
  const managedKeys = Object.keys(upserts);
  const keyLine = new RegExp(`^\\s*(?:export\\s+)?(${managedKeys.join("|")})\\s*=`);
  const seen = new Set();

  const lines = existing.length ? existing.split(/\r?\n/) : [];
  // Drop a single trailing empty element from a final newline so idempotent
  // re-runs never accumulate blank lines.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  const outLines = [];
  for (const line of lines) {
    const m = line.match(keyLine);
    if (m) {
      const key = m[1];
      if (!seen.has(key)) {
        outLines.push(`${key}=${upserts[key]}`); // replace in place
        seen.add(key);
      }
      continue; // drop this (and any later duplicate) managed line
    }
    outLines.push(line); // preserve unrelated line verbatim
  }
  // Append any managed key not already present (stable order).
  for (const key of managedKeys) {
    if (!seen.has(key)) outLines.push(`${key}=${upserts[key]}`);
  }

  const content = outLines.join("\n") + "\n";

  mkdir(dshHome, { recursive: true });
  // Atomic write: temp file (0600) in the same dir, then rename over target.
  const tmp = `${envPath}.tmp`;
  write(tmp, content, { mode: 0o600 });
  rename(tmp, envPath);
  return envPath;
}

/**
 * @param {import("../contracts.mjs").StepContext & {
 *   validateCredentials?: Function, appendAgent?: Function, writeLogin?: Function,
 *   promptFn?: Function,
 * }} ctx
 * @returns {Promise<import("../contracts.mjs").StepOutcome | import("../contracts.mjs").StepOutcome[]>}
 */
export async function seedCredentials(ctx) {
  const env = ctx.env ?? process.env;
  const io = ctx.io ?? {};
  const isTTY = !!io.isTTY;
  const flags = ctx.flags ?? {};
  const validate = ctx.validateCredentials ?? validateAndFetchIdentity;
  const append = ctx.appendAgent ?? defaultAppendAgentConfig;
  const resolveCwds = ctx.resolveInstallCwds ?? defaultResolveInstallCwds;
  const ask = ctx.promptFn ?? defaultPrompt;
  const writeDshEnv = ctx.writeDshEnv ?? writeDshCredentialsEnv;

  const selection = Array.isArray(ctx.selection) ? ctx.selection.filter((id) => nonEmpty(id)) : [];
  if (selection.length === 0) {
    return out(SKIPPED, "no agents selected — no credentials to seed");
  }

  // The Chorus server URL is shared across all selected agents (one Chorus
  // instance). Resolve it once from flags/env, prompting a single time on a TTY.
  let url = nonEmpty(flags.url) ?? nonEmpty(env.CHORUS_URL);
  if (!url && isTTY && typeof ask === "function") {
    url = nonEmpty(await ask("Chorus URL: "));
  }

  // Resolve the served working-directory SET once and stamp it PER-AGENT into each
  // agents[] entry below. The daemon reads cwds per agent (cfg.cwds is authoritative);
  // the flat top-level `cwds` is a deprecated single-agent leftover — writeConfig is a
  // no-op here so we take only the resolved value, never a top-level write (daemon-setup
  // no longer writes it either). Failure degrades to no cwds (daemon defaults to cwd).
  let cwds = [];
  try {
    const resolved = await resolveCwds(flags, {
      isTTY,
      skip: !isTTY || flags.yes === true,
      writeConfig: () => {},
      readJson: ctx.readJson,
      loginPath: ctx.loginPath,
      prompt: ask,
      log: typeof io.log === "function" ? io.log : () => {},
    });
    cwds = Array.isArray(resolved?.cwds) ? resolved.cwds : [];
  } catch {
    cwds = [];
  }

  /** @type {import("../contracts.mjs").StepOutcome[]} */
  const outcomes = [];

  for (let i = 0; i < selection.length; i += 1) {
    const id = selection[i];
    const agentType = agentTypeForSelection(id);

    // Key capture: the FIRST agent pre-fills from --api-key / CHORUS_API_KEY; every
    // agent prompts on a TTY. A later agent is NEVER handed an earlier agent's key.
    let apiKey = i === 0 ? nonEmpty(flags.apiKey) ?? nonEmpty(env.CHORUS_API_KEY) : undefined;
    if (!apiKey && isTTY && typeof ask === "function") {
      apiKey = nonEmpty(await ask(`Chorus API key for ${id} (cho_...): `, { mask: true }));
    }

    if (!url || !apiKey) {
      // Cannot capture this agent's own key (non-TTY, nothing pre-filled). Report it
      // — never silently reuse another identity's key across agents.
      const missing = !url ? "URL + API key" : "API key";
      outcomes.push(
        out(
          FAILED,
          `${id}: missing Chorus ${missing} — pass --url/--api-key (first agent) or run interactively; ` +
            `this agent still needs its own key`,
        ),
      );
      continue;
    }

    let identity;
    try {
      identity = await validate({ url, apiKey });
    } catch (err) {
      outcomes.push(out(FAILED, `${id}: credential validation failed: ${err?.message ?? String(err)}`));
      continue;
    }

    // daemon-wake opt-in (only for a daemon-wakeable backend; offline agents can never
    // be woken, so they get NO daemonWake field). DEFAULT off: an added agent is parked
    // (its key serves `chorus mcp`) but not woken until the operator opts in — via
    // `--daemon-wake <ids>` / `--daemon-wake-all`, or a per-agent prompt on a TTY.
    let daemonWake;
    if (isWakeableAgentType(agentType)) {
      const flaggedAll = flags.daemonWakeAll === true;
      const flaggedThis = Array.isArray(flags.daemonWake) && flags.daemonWake.includes(id);
      if (flaggedAll || flaggedThis) {
        daemonWake = true;
      } else if (isTTY && typeof ask === "function") {
        const ans = String(
          (await ask(`Enable daemon waking for ${identity.name} (${agentType})? [y/N]: `)) ?? "",
        ).trim();
        daemonWake = /^y(es)?$/i.test(ans);
      } else {
        daemonWake = false; // non-TTY default: not woken
      }
    }

    // Append as its own agents[] entry, tagged with the mapped daemon agentType
    // (offline when the backend isn't daemon-wakeable), its OWN cwds, and the resolved
    // daemonWake (explicit boolean for wakeable backends; omitted for offline).
    // Merge-safe; dedups on key; only touches the newly-added entry.
    const res = append({
      url,
      apiKey,
      agentType,
      agentUuid: identity.uuid,
      agentName: identity.name,
      ...(cwds.length ? { cwds } : {}),
      ...(daemonWake !== undefined ? { daemonWake } : {}),
    });

    // dsh-only: ALSO restore the retired dsh-credentials.sh channel by seeding
    // $DSH_HOME/.env, so the doc-mirror wrapper resolves creds when `chorus` is
    // off PATH (the npx init path). Runs regardless of the daemon.json dedup
    // result (an idempotent re-run still repairs a missing/stale .env). Only the
    // path is ever surfaced — never the key.
    let dshNote = "";
    // When the profile is persisted in $DSH_HOME/.env, dsh loads it into the session
    // env for free — so init.mjs SKIPS the manual `export CHORUS_AGENT_PROFILE=…`
    // hint for this agent (every non-dsh agent still gets the hint). Only set on a
    // successful .env write; if it failed, the hint is still shown as a fallback.
    let profileInEnv = false;
    if (isDshSelection(id)) {
      try {
        const envPath = writeDshEnv({ dshHome: resolveDshHome(env), url, apiKey, agentProfile: identity.uuid });
        dshNote = `; seeded CHORUS_URL/CHORUS_API_KEY/CHORUS_AGENT_PROFILE into ${envPath} (0600)`;
        profileInEnv = true;
      } catch (err) {
        dshNote = `; WARNING: could not seed $DSH_HOME/.env: ${err?.message ?? String(err)}`;
      }
    }

    if (!res.ok) {
      outcomes.push(
        out(
          SKIPPED,
          `${id}: ${identity.name} (${identity.uuid}) already configured (same key) — left unchanged${dshNote}`,
          // Carry the identity so the orchestrator can print a CHORUS_AGENT_PROFILE
          // export hint even on an idempotent re-run (the agent is still configured).
          { agentUuid: identity.uuid, agentName: identity.name, ...(profileInEnv ? { profileInEnv: true } : {}) },
        ),
      );
      continue;
    }
    outcomes.push(
      out(
        SEEDED,
        `${id}: seeded ${identity.name} (${identity.uuid}) as ${agentType} → agents[${res.index}] in ~/.chorus/daemon.json${dshNote}`,
        // Structured identity for the completion profile-export hint (init.mjs).
        { agentUuid: identity.uuid, agentName: identity.name, ...(profileInEnv ? { profileInEnv: true } : {}) },
      ),
    );
  }

  return outcomes;
}

/** @type {import("../contracts.mjs").InitStep} */
export const credentialSeedStep = {
  id: STEP_ID,
  order: 10, // before plugin-install (order 20)
  scope: STEP_SCOPES.ONCE,
  run: seedCredentials,
};

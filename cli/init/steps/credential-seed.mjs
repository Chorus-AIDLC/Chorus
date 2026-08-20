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
// Key handling: keys are validated then written 0600 (via updateDaemonConfig) and
// never echoed. A subsequent selected agent is NEVER given the first agent's key —
// on a non-TTY where its key can't be captured, the agent is REPORTED as still
// needing one rather than silently reusing an identity.
//
// Runs BEFORE plugin-install (order 10 < 20) so a machine is authenticated before
// its agents are wired.

import { STEP_SCOPES, OUTCOME_ACTIONS } from "../contracts.mjs";
import {
  prompt as defaultPrompt,
  appendAgentConfig as defaultAppendAgentConfig,
} from "../../login.mjs";
import { validateAndFetchIdentity } from "../../chorus-client.mjs";
import { agentTypeForSelection } from "../agent-type-map.mjs";

const STEP_ID = "credential-seed";
const { SEEDED, SKIPPED, FAILED } = OUTCOME_ACTIONS;
const out = (action, detail) => ({ stepId: STEP_ID, action, detail });

/** A non-empty trimmed string, or undefined. */
function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
  const ask = ctx.promptFn ?? defaultPrompt;

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

    // Append as its own agents[] entry, tagged with the mapped daemon agentType
    // (offline when the backend isn't daemon-wakeable). Merge-safe; dedups on key.
    const res = append({ url, apiKey, agentType, agentUuid: identity.uuid, agentName: identity.name });
    if (!res.ok) {
      outcomes.push(
        out(SKIPPED, `${id}: ${identity.name} (${identity.uuid}) already configured (same key) — left unchanged`),
      );
      continue;
    }
    outcomes.push(
      out(
        SEEDED,
        `${id}: seeded ${identity.name} (${identity.uuid}) as ${agentType} → agents[${res.index}] in ~/.chorus/daemon.json`,
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

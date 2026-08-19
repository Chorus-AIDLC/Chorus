// cli/init/steps/credential-seed.mjs
// The `once`-scoped step that captures Chorus credentials ONE time per
// `chorus init` run and seeds them into the centralized daemon config
// (~/.chorus/daemon.json) — owner decision: credentials live in the daemon, not
// per-agent. It reuses the existing, tested credential plumbing:
//   - validateAndFetchIdentity (cli/chorus-client.mjs) to validate the key
//   - writeLoginFile → updateDaemonConfig (cli/login.mjs), a MERGE-SAFE writer
//     that preserves every other field already on disk (yoloAckAt, cwds,
//     agents[], sigintTimeoutMs, …)
// It never writes the API key into any per-agent configuration.
//
// Runs BEFORE plugin-install (order 10 < 20) so a machine is authenticated
// before its agents are wired.

import { STEP_SCOPES, OUTCOME_ACTIONS } from "../contracts.mjs";
import { prompt as defaultPrompt, writeLoginFile as defaultWriteLoginFile } from "../../login.mjs";
import { validateAndFetchIdentity } from "../../chorus-client.mjs";
import { resolveCredentials } from "../../credentials.mjs";

const STEP_ID = "credential-seed";
const { SEEDED, SKIPPED, FAILED } = OUTCOME_ACTIONS;
const out = (action, detail) => ({ stepId: STEP_ID, action, detail });

/** A non-empty trimmed string, or undefined. */
function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * @param {import("../contracts.mjs").StepContext & {
 *   validateCredentials?: Function, writeLogin?: Function, promptFn?: Function,
 *   resolveExisting?: Function,
 * }} ctx
 * @returns {Promise<import("../contracts.mjs").StepOutcome>}
 */
export async function seedCredentials(ctx) {
  const env = ctx.env ?? process.env;
  const io = ctx.io ?? {};
  const isTTY = !!io.isTTY;
  const flags = ctx.flags ?? {};
  const validate = ctx.validateCredentials ?? validateAndFetchIdentity;
  const write = ctx.writeLogin ?? defaultWriteLoginFile;
  const ask = ctx.promptFn ?? defaultPrompt;

  let url = nonEmpty(flags.url) ?? nonEmpty(env.CHORUS_URL);
  let apiKey = nonEmpty(flags.apiKey) ?? nonEmpty(env.CHORUS_API_KEY);

  // Prompt for anything missing only when attached to a TTY.
  if ((!url || !apiKey) && isTTY && typeof ask === "function") {
    if (!url) url = nonEmpty(await ask("Chorus URL: "));
    if (!apiKey) apiKey = nonEmpty(await ask("Chorus API key (cho_...): ", { mask: true }));
  }

  if (!url || !apiKey) {
    // Nothing supplied and nothing to prompt with. If a complete credential pair
    // already resolves (existing daemon.json / plugin env), leave it untouched;
    // otherwise this is a hard, visible failure — never a silent skip.
    const resolveExisting = ctx.resolveExisting ?? (() => resolveCredentials({}, { env }));
    try {
      resolveExisting();
      return out(SKIPPED, "credentials already present (daemon.json / env) — left unchanged");
    } catch {
      return out(
        FAILED,
        "no Chorus credentials — pass --url/--api-key, set CHORUS_URL/CHORUS_API_KEY, or run `chorus login`",
      );
    }
  }

  let identity;
  try {
    identity = await validate({ url, apiKey });
  } catch (err) {
    return out(FAILED, `credential validation failed: ${err?.message ?? String(err)}`);
  }

  // Merge-safe write: only the credential/identity fields; writeLoginFile
  // preserves everything else on disk (yoloAckAt, cwds, agents[], …).
  write({ url, apiKey, agentUuid: identity.uuid, agentName: identity.name });
  return out(SEEDED, `seeded credentials for ${identity.name} (${identity.uuid}) → ~/.chorus/daemon.json`);
}

/** @type {import("../contracts.mjs").InitStep} */
export const credentialSeedStep = {
  id: STEP_ID,
  order: 10, // before plugin-install (order 20)
  scope: STEP_SCOPES.ONCE,
  run: seedCredentials,
};

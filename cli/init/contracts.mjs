// cli/init/contracts.mjs
// Shared contracts for `chorus init` (idea c055e285, A1 foundation). Two
// extension points let sibling ideas grow the command without editing its core:
//
//   1. AgentAdapter — one per coding-agent harness (Claude Code, Codex, Kiro,
//      opencode, OpenClaw, Pi, dsh). Adding an agent = adding an adapter to the
//      registry (cli/init/registry.mjs). Detection, install-state read, and the
//      plugin install all live behind this interface.
//
//   2. InitStep — one per configuration concern. THIS change ships the
//      credential-seed step (scope "once") and the plugin-install step (scope
//      "per-agent"). Sibling ideas register more steps (MCP proxy cc115e6b,
//      daemon setup a7c2a3e8) into the same ordered registry.
//
// Iteration ownership (resolves proposal-review note #3): the ORCHESTRATOR
// (runInit) owns per-agent iteration. A `per-agent` step's run(ctx) is invoked
// once per selected agent with ctx.agentId set; a `once` step's run(ctx) is
// invoked a single time with ctx.agentId undefined. Steps never loop the
// selection themselves.
//
// Plain ESM, zero dependencies — ships verbatim in the npm package. This module
// is intentionally (mostly) JSDoc typedefs plus a few frozen enums so the shape
// is one source of truth for the whole cli/init tree and its tests.

/**
 * Step scopes. `once` runs a single time per `chorus init` invocation;
 * `per-agent` runs once for each selected agent.
 * @readonly
 */
export const STEP_SCOPES = Object.freeze({ ONCE: "once", PER_AGENT: "per-agent" });

/**
 * Terminal per-unit outcomes a step reports for the summary table.
 * - installed: a fresh configuration was applied
 * - repaired:  an existing but incomplete/broken configuration was fixed
 * - skipped:   already configured / nothing to do
 * - seeded:    a `once` step persisted shared state (e.g. credentials)
 * - failed:    the unit could not be configured (detail carries the reason)
 * - unsupported: the agent has no verified automated mechanism (guided message)
 * @readonly
 */
export const OUTCOME_ACTIONS = Object.freeze({
  INSTALLED: "installed",
  REPAIRED: "repaired",
  SKIPPED: "skipped",
  SEEDED: "seeded",
  FAILED: "failed",
  UNSUPPORTED: "unsupported",
});

/** Outcome actions that mean "this unit did not succeed" — drive the exit code. */
export const FAILURE_ACTIONS = Object.freeze([OUTCOME_ACTIONS.FAILED]);

/**
 * @typedef {Object} AgentDetection
 * @property {string} id            Stable adapter id (e.g. "claude").
 * @property {string} displayName   Human label (e.g. "Claude Code").
 * @property {boolean} binaryOnPath Whether the agent's CLI resolves on PATH.
 * @property {boolean} configDirPresent Whether the agent's config dir exists.
 * @property {boolean} detected     `binaryOnPath || configDirPresent` — drives
 *                                  default pre-selection only, never gates choice.
 */

/**
 * @typedef {Object} AgentInstallState
 * @property {boolean} supported    Whether an automated install is available on
 *                                  this machine (false ⇒ guided message only).
 * @property {boolean} marketplaceRegistered Whether the Chorus marketplace/source
 *                                  is already registered for this agent.
 * @property {boolean} pluginInstalled Whether the Chorus plugin is already installed.
 * @property {string} [version]     Installed plugin version, when known.
 * @property {string} [detail]      Optional human note (e.g. why unsupported).
 */

/**
 * @typedef {Object} AgentAdapter
 * @property {string} id
 * @property {string} displayName
 * @property {(env: NodeJS.ProcessEnv) => {binaryOnPath: boolean, configDirPresent: boolean}} detect
 *   Pure-ish: may stat the filesystem and look up PATH; MUST NOT mutate anything.
 * @property {(deps: object) => AgentInstallState} readInstallState
 *   Read-only idempotency probe (e.g. parse the agent's own state files).
 * @property {(ctx: StepContext) => StepOutcome} installPlugin
 *   Register the agent's native remote marketplace and install/enable the Chorus
 *   plugin surface. MUST be idempotent, MUST back up before overwrite via
 *   ctx.backup(), and MUST NOT write any per-agent MCP/credential config.
 */

/**
 * @typedef {Object} InitStep
 * @property {string} id            Stable step id (e.g. "credential-seed").
 * @property {number} order         Ascending run order.
 * @property {("once"|"per-agent")} scope
 * @property {(ctx: StepContext) => (StepOutcome | Promise<StepOutcome>)} run
 */

/**
 * @typedef {Object} StepOutcome
 * @property {string} stepId
 * @property {string} [agentId]     Present for per-agent outcomes.
 * @property {("installed"|"repaired"|"skipped"|"seeded"|"failed"|"unsupported")} action
 * @property {string} detail        One-line human explanation for the summary.
 */

/**
 * @typedef {Object} StepContext
 * @property {string[]} selection   Selected agent ids (for `once` steps that need the set).
 * @property {string} [agentId]     The current agent id (per-agent steps only).
 * @property {AgentAdapter} [adapter] The current agent's adapter (per-agent steps only).
 * @property {object} flags         Parsed init flags (see cli/init-args.mjs).
 *   `flags.updateInstalled` is the orchestrator-resolved, invocation-wide
 *   decision to refresh selected installed plugin payloads.
 * @property {{ log: (m: string) => void, ask: Function, isTTY: boolean }} io
 * @property {(path: string) => (string|null)} backup  Copy a file to <path>.chorus-bak
 *   once before overwrite; returns the backup path or null if the source is absent.
 * @property {NodeJS.ProcessEnv} env
 */

/** True when an outcome represents a failure (drives the process exit code). */
export function isFailureOutcome(outcome) {
  return !!outcome && FAILURE_ACTIONS.includes(outcome.action);
}

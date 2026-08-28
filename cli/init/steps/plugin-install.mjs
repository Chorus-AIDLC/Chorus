// cli/init/steps/plugin-install.mjs
// The per-agent plugin-install step `chorus init` ships (idea c055e285, A1).
// The orchestrator invokes run(ctx) once per selected agent with ctx.agentId +
// ctx.adapter set; the step delegates to the agent's own installPlugin (whose
// per-agent mechanics live in cli/init/install-methods.mjs). Per-agent failures
// are isolated by returning a `failed` outcome — never throwing — so one agent
// cannot abort the others.

import { STEP_SCOPES, OUTCOME_ACTIONS } from "../contracts.mjs";

/** @type {import("../contracts.mjs").InitStep} */
export const pluginInstallStep = {
  id: "plugin-install",
  order: 20, // after credential-seed (order 10)
  scope: STEP_SCOPES.PER_AGENT,
  run(ctx) {
    const adapter = ctx.adapter;
    if (!adapter || typeof adapter.installPlugin !== "function") {
      return {
        stepId: "plugin-install",
        agentId: ctx.agentId,
        action: OUTCOME_ACTIONS.FAILED,
        detail: "no adapter resolved for this agent",
      };
    }
    try {
      return adapter.installPlugin(ctx);
    } catch (err) {
      return {
        stepId: "plugin-install",
        agentId: adapter.id,
        action: OUTCOME_ACTIONS.FAILED,
        detail: `install threw: ${err?.message ?? String(err)}`,
      };
    }
  },
};

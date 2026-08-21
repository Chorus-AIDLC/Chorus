// cli/init/agent-type-map.mjs
// The single translation between a `chorus init` adapter selection id (see
// cli/init/adapters.mjs — "claude" | "codex" | "kiro" | "opencode" | "openclaw" |
// "pi" | "dsh") and the daemon's agentType vocabulary (cli/daemon-agent.mjs
// KNOWN_AGENTS). It lives in ONE place so the credential-seed step (which writes
// each selected agent's daemon.json agents[] entry) and the daemon-setup step
// (which gates auto-start on whether any selected agent is wakeable) can never
// disagree about how a selection maps to a backend.
//
// Two rules the callers rely on:
//   1. The init id "claude" is NOT the daemon agentType — it renames to
//      "claude-code" EXPLICITLY here. No caller ever passes the raw init id
//      through to daemon.json; every write goes through agentTypeForSelection.
//   2. Any selection the daemon cannot wake as a first-class backend
//      (opencode / openclaw / pi, and dsh while its harness is dormant/offline)
//      maps to the non-wakeable "offline" classification. Its key is still parked
//      in agents[] for the `chorus mcp` proxy, but the daemon builds no spawner
//      and dispatches no wake (spawner-select.mjs fail-closes on "offline").
//
// Fail-closed by default: an unknown / unmapped id maps to "offline" rather than a
// wakeable backend, so a future adapter added without a mapping is never silently
// woken as claude-code.

/**
 * Selection id → daemon agentType. Only claude/codex/kiro are wakeable backends;
 * everything else is classified offline. `dsh` maps to offline because the dsh
 * harness is de-advertised (offline) — re-map it here to bring it back online.
 * @type {Readonly<Record<string, string>>}
 */
export const SELECTION_TO_AGENT_TYPE = Object.freeze({
  claude: "claude-code", // explicit rename — never pass the init id "claude" through verbatim
  codex: "codex",
  kiro: "kiro",
  opencode: "offline",
  openclaw: "offline",
  pi: "offline",
  dsh: "offline",
});

/**
 * Map a `chorus init` selection id to the daemon agentType written into
 * daemon.json `agents[]`. Unknown ids fail closed to "offline" (never a wakeable
 * default), so an agent is only ever woken when its backend is explicitly known.
 * @param {string} selectionId
 * @returns {string} a KNOWN_AGENTS agentType ("claude-code" | "codex" | "kiro" | "offline")
 */
export function agentTypeForSelection(selectionId) {
  return SELECTION_TO_AGENT_TYPE[selectionId] ?? "offline";
}

/**
 * Whether a daemon agentType is one the daemon can actually wake. "offline" is the
 * one non-wakeable classification; every other value the init mapping produces
 * (claude-code / codex / kiro) is wakeable.
 * @param {string} agentType
 * @returns {boolean}
 */
export function isWakeableAgentType(agentType) {
  return agentType !== "offline";
}

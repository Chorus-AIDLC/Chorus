// cli/cli-session-sync/index.mjs
// Backend → session-sync adapter registry (cli-agent-session-sync D3). Keys are the
// launcher's effective agent types (cli/agent-launcher.mjs TYPE_TO_BINARY). A backend
// plugs in by adding its adapter module here; until then it falls back to the
// registration-only, non-continuable adapter.

import { normalizeAdapter, createNonResumableAdapter } from "./contract.mjs";
import { claudeAdapter } from "./claude.mjs";
import { codexAdapter, traeAdapter } from "./codex.mjs";
import { piAdapter } from "./pi.mjs";
import { kiroAdapter } from "./kiro.mjs";

export { normalizeAdapter, createNonResumableAdapter, defaultInspection } from "./contract.mjs";

/** @type {Readonly<Record<string, import("./contract.mjs").SessionSyncAdapter>>} */
export const SESSION_SYNC_ADAPTERS = Object.freeze({
  "claude-code": claudeAdapter,
  claude: claudeAdapter,
  pi: piAdapter,
  codex: codexAdapter,
  trae: traeAdapter,
  kiro: kiroAdapter,
  // opencode / openclaw / dsh: no resumable identity → registration-only fallback.
});

/**
 * Resolve the adapter for an effective agent type. Unknown or not-yet-adapted backends
 * get the non-resumable adapter (registered + visible, never continuable).
 * @param {string} agentType
 * @param {Record<string, import("./contract.mjs").SessionSyncAdapter>} [registry]
 * @returns {Required<import("./contract.mjs").SessionSyncAdapter>}
 */
export function getSessionSyncAdapter(agentType, registry = SESSION_SYNC_ADAPTERS) {
  const adapter = Object.prototype.hasOwnProperty.call(registry, agentType) ? registry[agentType] : null;
  return normalizeAdapter(adapter ?? createNonResumableAdapter(String(agentType)));
}

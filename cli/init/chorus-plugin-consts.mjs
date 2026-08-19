// cli/init/chorus-plugin-consts.mjs
// Canonical Chorus plugin/marketplace identifiers, shared by the adapters and the
// per-agent install methods. Kept in its own module so adapters.mjs and
// install-methods.mjs can both import them without a circular dependency.

/** Plugin selector used by marketplace-based agents (Claude Code, Codex). */
export const CHORUS_PLUGIN_ID = "chorus@chorus-plugins";
/** Marketplace name as it appears in agents' on-disk state. */
export const CHORUS_MARKETPLACE_NAME = "chorus-plugins";
/**
 * Remote marketplace source (owner decision: each agent's NATIVE REMOTE
 * marketplace, not a local bundle). Overridable per invocation via
 * CHORUS_MARKETPLACE_SOURCE. Accepted by `claude plugin marketplace add`
 * (URL/path/repo). Codex prefers the `owner/repo` slug — see installCodex.
 */
export const CHORUS_MARKETPLACE_SOURCE = "https://github.com/Chorus-AIDLC/Chorus";

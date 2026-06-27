// cli/daemon-agent.mjs
// Pure resolution + validation of the daemon's `--agent <type>` selection.
// `claude-code` (the default) and `codex` are both implemented backends
// (add-daemon-codex-backend cashed in the reserved `codex` slot). Resolving an
// unknown value is a hard error (no silent fallback). Zero dependencies.

/** The agent backends the daemon recognizes. Both are implemented (claude-code
 * via ClaudeSpawner, codex via CodexSpawner — see spawner-select.mjs). */
export const KNOWN_AGENTS = ["claude-code", "codex"];

/** The default agent backend when neither --agent nor CHORUS_AGENT is set. */
export const DEFAULT_AGENT = "claude-code";

/**
 * Resolve the agent type from flag → env → default, and validate it.
 * Precedence: explicit `--agent` flag > CHORUS_AGENT env > DEFAULT_AGENT.
 *
 * @param {{ agent?: string }} flags
 * @param {Record<string, string|undefined>} env
 * @returns {{ ok: true, agent: string } | { ok: false, value: string, error: string }}
 *   `ok:false` carries the offending value and a human-actionable error naming
 *   the accepted types — the caller exits non-zero and prints `error`.
 */
export function resolveAgentType(flags, env) {
  const raw =
    (typeof flags.agent === "string" && flags.agent.trim()) ||
    (typeof env.CHORUS_AGENT === "string" && env.CHORUS_AGENT.trim()) ||
    DEFAULT_AGENT;
  if (!KNOWN_AGENTS.includes(raw)) {
    return {
      ok: false,
      value: raw,
      error:
        `Unknown --agent "${raw}". Accepted: ${KNOWN_AGENTS.join(", ")}. ` +
        `(Default is ${DEFAULT_AGENT}.)`,
    };
  }
  return { ok: true, agent: raw };
}

// cli/agent-backend-prompt.mjs
// Single source of truth for the interactive "which agent backend?" menu shared
// by the daemon credential-capture entry points: `chorus login` (single-agent),
// `chorus login --add` / `chorus daemon add`, and the `chorus install` "add
// another agent" loop (see cli/login.mjs, cli/daemon-install-config.mjs).
//
// The same AGENT_MENU list also feeds resolveInstallAgent's daemon-level backend
// prompt in daemon-install-config.mjs, so every surface advertises EXACTLY the
// same backends and never drifts — re-advertising a backend (e.g. dsh) is a
// one-line edit here that all prompts pick up.
//
// promptAgentBackend deliberately differs from resolveInstallAgent's inline menu
// in ONE way: an empty / unrecognized answer returns `undefined` ("no explicit
// choice") rather than DEFAULT_AGENT, so the add/login callers can OMIT the
// backend field and let resolve-time inheritance apply (the daemon top-level
// default). resolveInstallAgent must always produce a concrete daemon-level
// backend, so it keeps its own empty→DEFAULT_AGENT behavior and does NOT use
// this helper.
//
// Lives in its own module to avoid an import cycle: daemon-install-config.mjs
// already imports appendAgentConfig from login.mjs, so the shared menu cannot
// live in either of those files.

import { KNOWN_AGENTS } from "./daemon-agent.mjs";

/**
 * The interactive agent-backend menu. Order mirrors KNOWN_AGENTS with claude-code
 * first (it is the default). Kept as the single shared list so the numbered
 * prompt and the accepted values never drift across entry points.
 *
 * NOTE: the dsh JSON-RPC daemon backend is temporarily de-advertised (offline).
 * The code path (probeAgentCli/resolveDshPath, spawner-select, dsh-spawner) is
 * kept dormant — re-add this menu entry to bring it back online. It remains
 * reachable by name (e.g. `--agent dsh`, or typing "dsh" at the prompt).
 *
 * pi IS advertised: it is a first-class wakeable backend (PiSpawner /
 * add-daemon-pi-backend), unlike the dormant dsh, so it sits in the numbered
 * menu alongside claude-code / codex / kiro.
 */
export const AGENT_MENU = [
  { value: "claude-code", label: "Claude Code (default)" },
  { value: "codex", label: "Codex CLI" },
  { value: "kiro", label: "Kiro CLI" },
  { value: "pi", label: "Pi" },
];

/** A non-empty trimmed string, or undefined. */
function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Prompt the operator to pick an agent backend for the agent being configured,
 * shared by the add / login / install-add flows.
 *
 * Returns the chosen backend value, or `undefined` when the operator makes no
 * explicit choice — meaning "inherit the daemon default" (the caller then omits
 * the `agentType` / top-level `agent` field). `undefined` is returned when:
 *   - `isTTY` is false (non-interactive / piped) — returns immediately, prints
 *     nothing, never blocks (mirrors resolveInstallAgent / resolveDaemonCwds);
 *   - the answer is empty (Enter);
 *   - the answer is an out-of-range number or is otherwise unrecognized.
 *
 * Accepts either a menu number (1..AGENT_MENU.length) or a KNOWN_AGENTS value
 * typed by name (e.g. "codex", or "dsh" even though it is de-advertised).
 *
 * @param {{
 *   ask: (query: string, opts?: object) => Promise<string>,
 *   log?: (m: string) => void,
 *   isTTY?: boolean,
 * }} deps
 * @returns {Promise<string|undefined>}
 */
export async function promptAgentBackend({ ask, log = () => {}, isTTY = false } = {}) {
  // Non-TTY (piped / scripted) must never block on a menu — return immediately
  // with no output. The caller falls back to --agent or inherits the default.
  if (!isTTY || typeof ask !== "function") return undefined;

  log("[Chorus] Which agent backend should this agent use?");
  for (let i = 0; i < AGENT_MENU.length; i += 1) {
    log(`[Chorus]   ${i + 1}) ${AGENT_MENU[i].label}`);
  }
  const answer = nonEmpty(
    await ask(`Select [1-${AGENT_MENU.length}] (Enter to inherit the daemon default): `),
  );
  if (!answer) return undefined; // Enter → inherit default.

  const n = Number(answer);
  if (Number.isInteger(n) && n >= 1 && n <= AGENT_MENU.length) {
    return AGENT_MENU[n - 1].value;
  }
  // A backend typed by name (muscle memory). KNOWN_AGENTS includes the
  // de-advertised `dsh` backend AND the non-wakeable `offline` classification, so a
  // by-name pick can still reach either even though neither is in the numbered menu.
  if (KNOWN_AGENTS.includes(answer)) return answer;

  // Out-of-range / garbage → no explicit choice; the caller inherits the default.
  return undefined;
}

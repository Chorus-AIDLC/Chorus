// cli/init/select.mjs
// Resolve WHICH agents `chorus init` will configure, from parsed flags +
// detection + TTY state. Pure and dependency-injected (no direct process/IO):
// the interactive prompt uses an injected `ask`, so this unit-tests without a
// real terminal. Mirrors the cli/*.mjs pure-module convention.
//
// Precedence:
//   1. --agents <ids>  → exactly those ids (validated against the registry).
//   2. --all           → every supported agent.
//   3. interactive TTY → numbered checklist, detected agents pre-checked.
//   4. non-TTY w/ neither → ABORT (never guess which agents to touch).

/**
 * @typedef {import("./contracts.mjs").AgentDetection} AgentDetection
 */

/**
 * @param {{
 *   flags: { agents?: string[], all?: boolean },
 *   detections: AgentDetection[],   // ALL supported agents, each with `detected`
 *   io: { log: (m: string) => void, ask?: Function, isTTY?: boolean },
 * }} params
 * @returns {Promise<{ selectedIds?: string[], error?: string }>}
 *   `error` set (a human message) ⇒ the command aborts non-zero and configures nothing.
 */
export async function resolveSelection({ flags = {}, detections = [], io = {} }) {
  const validIds = detections.map((d) => d.id);
  const validSet = new Set(validIds);
  const list = () => validIds.join(", ");

  // 1. Explicit --agents.
  if (Array.isArray(flags.agents)) {
    if (flags.agents.length === 0) {
      return { error: `No agent ids given to --agents. Valid ids: ${list()}.` };
    }
    const unknown = flags.agents.filter((id) => !validSet.has(id));
    if (unknown.length) {
      return {
        error: `Unknown agent id(s): ${unknown.join(", ")}. Valid ids: ${list()}.`,
      };
    }
    return { selectedIds: flags.agents.slice() };
  }

  // 2. --all.
  if (flags.all) {
    return { selectedIds: validIds.slice() };
  }

  // 3 / 4. No explicit selection.
  const isTTY = !!io.isTTY && typeof io.ask === "function";
  if (!isTTY) {
    return {
      error:
        "Non-interactive: no TTY to prompt. Pass --agents <ids> or --all to choose " +
        `which agents to configure. Valid ids: ${list()}.`,
    };
  }

  return promptChecklist({ detections, io });
}

/**
 * Interactive numbered checklist. Detected agents are pre-checked; the user
 * enters a comma-separated list of numbers, or presses Enter to accept the
 * detected default. Returns an error when the resulting selection is empty
 * (nothing to do is treated as an abort, not a silent no-op).
 * @param {{ detections: AgentDetection[], io: { log: Function, ask: Function } }} params
 * @returns {Promise<{ selectedIds?: string[], error?: string }>}
 */
async function promptChecklist({ detections, io }) {
  const defaults = detections.filter((d) => d.detected).map((d) => d.id);
  io.log("[chorus agents add] Detected coding agents (✓ = found on this machine):");
  detections.forEach((d, i) => {
    io.log(`  ${i + 1}) ${d.detected ? "✓" : " "} ${d.displayName} (${d.id})`);
  });
  const defaultHint = defaults.length
    ? `Enter to accept detected [${defaults.join(", ")}]`
    : "Enter to select none";
  const answer = String(
    (await io.ask(`Configure which? comma-separated numbers, or ${defaultHint}: `)) ?? "",
  ).trim();

  if (!answer) {
    if (!defaults.length) {
      return { error: "No agents detected and none selected — nothing to configure." };
    }
    return { selectedIds: defaults };
  }

  /** @type {string[]} */
  const picked = [];
  const seen = new Set();
  for (const tok of answer.split(",")) {
    const n = Number(tok.trim());
    if (!Number.isInteger(n) || n < 1 || n > detections.length) {
      return {
        error: `Invalid selection "${tok.trim()}". Enter numbers between 1 and ${detections.length}.`,
      };
    }
    const id = detections[n - 1].id;
    if (!seen.has(id)) {
      seen.add(id);
      picked.push(id);
    }
  }
  if (!picked.length) {
    return { error: "No agents selected — nothing to configure." };
  }
  return { selectedIds: picked };
}

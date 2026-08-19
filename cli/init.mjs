// cli/init.mjs
// `chorus init` orchestrator (idea c055e285, A1). Dependency-injected so it
// unit-tests without real detection / prompts / filesystem, mirroring the pure
// entry-point style of cli/embedded-db.mjs and cli/client-args.mjs.
//
// Flow: parse flags → detect agents → resolve selection → run ordered steps →
// print per-agent summary → exit code. The ORCHESTRATOR owns per-agent
// iteration: `once` steps run a single time; `per-agent` steps run once per
// selected agent with ctx.agentId + ctx.adapter set (contracts.mjs).

import { createInterface } from "node:readline";
import { copyFileSync, existsSync } from "node:fs";
import { parseInitFlags, initHelpText } from "./init-args.mjs";
import { resolveSelection as defaultResolveSelection } from "./init/select.mjs";
import { STEP_SCOPES, OUTCOME_ACTIONS, isFailureOutcome } from "./init/contracts.mjs";

/** Build the default runtime IO (real terminal). Only called at run time. */
function defaultIo() {
  const isTTY = !!(process.stdin.isTTY && process.stdout.isTTY);
  return {
    log: (m) => console.log(m),
    isTTY,
    ask: isTTY
      ? (query) =>
          new Promise((resolve) => {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            rl.question(query, (answer) => {
              rl.close();
              resolve(answer);
            });
          })
      : undefined,
  };
}

/** Copy a file to `<path>.chorus-bak` once before overwrite (idempotent). */
function backupFile(path) {
  try {
    if (!existsSync(path)) return null;
    const bak = `${path}.chorus-bak`;
    if (!existsSync(bak)) copyFileSync(path, bak);
    return bak;
  } catch {
    return null;
  }
}

/**
 * Run `chorus init`.
 * @param {string[]} argv  args after the `init` subcommand token
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   version?: string,
 *   io?: { log: Function, ask?: Function, isTTY?: boolean },
 *   parse?: (argv: string[]) => object,
 *   resolveSelection?: Function,
 *   detectAgents?: (env: NodeJS.ProcessEnv) => object[],
 *   orderedSteps?: () => object[],
 *   getAdapter?: (id: string) => (object | undefined),
 *   backup?: (path: string) => (string | null),
 * }} [deps]
 * @returns {Promise<number>} process exit code
 */
export async function runInit(argv = [], deps = {}) {
  const env = deps.env ?? process.env;
  const io = deps.io ?? defaultIo();
  const parse = deps.parse ?? parseInitFlags;
  const resolveSelection = deps.resolveSelection ?? defaultResolveSelection;
  const backup = deps.backup ?? backupFile;

  const flags = parse(argv);

  if (flags.help) {
    io.log(initHelpText(deps.version ?? ""));
    return 0;
  }

  // Lazy defaults so importing this module never requires the registry to be
  // fully populated (the registry is filled incrementally by sibling tasks).
  const detectAgents =
    deps.detectAgents ?? ((e) => import("./init/registry.mjs").then((m) => m.detectAgents(e)));
  const orderedSteps =
    deps.orderedSteps ?? (() => import("./init/registry.mjs").then((m) => m.orderedSteps()));
  const getAdapter =
    deps.getAdapter ?? ((id) => import("./init/registry.mjs").then((m) => m.getAdapter(id)));

  const detections = await detectAgents(env);
  const { selectedIds, error } = await resolveSelection({ flags, detections, io });
  if (error) {
    io.log(`[chorus init] ${error}`);
    return 1;
  }
  if (!selectedIds || selectedIds.length === 0) {
    io.log("[chorus init] Nothing to configure.");
    return 0;
  }

  io.log(`[chorus init] Configuring: ${selectedIds.join(", ")}`);

  const steps = await orderedSteps();
  // `ctxExtras` lets a caller/test inject step-context collaborators (e.g. a
  // fake credential validator or command runner) so an end-to-end run is
  // hermetic; production passes none and steps use their real defaults.
  const baseCtx = { selection: selectedIds, flags, io, env, backup, ...(deps.ctxExtras ?? {}) };
  /** @type {import("./init/contracts.mjs").StepOutcome[]} */
  const outcomes = [];

  for (const step of steps) {
    try {
      if (step.scope === STEP_SCOPES.PER_AGENT) {
        for (const agentId of selectedIds) {
          const adapter = await getAdapter(agentId);
          outcomes.push(await step.run({ ...baseCtx, agentId, adapter }));
        }
      } else {
        outcomes.push(await step.run(baseCtx));
      }
    } catch (err) {
      // A crashing step becomes a visible failed outcome, never a silent abort.
      outcomes.push({
        stepId: step.id,
        action: OUTCOME_ACTIONS.FAILED,
        detail: `step threw: ${err?.message ?? String(err)}`,
      });
    }
  }

  summarize(outcomes.flat(), io, selectedIds);
  return outcomes.flat().some(isFailureOutcome) ? 1 : 0;
}

/** Print the per-outcome summary table. */
export function summarize(outcomes, io, selectedIds = []) {
  io.log("");
  io.log("[chorus init] Summary:");
  if (outcomes.length === 0) {
    io.log("  (no steps registered yet)");
  }
  for (const o of outcomes) {
    const who = o.agentId ? `${o.agentId}` : o.stepId;
    io.log(`  - ${who}: ${o.action}${o.detail ? ` — ${o.detail}` : ""}`);
  }
  const failed = outcomes.filter(isFailureOutcome);
  if (failed.length) {
    io.log(`[chorus init] ${failed.length} step(s) failed — see above.`);
  } else if (selectedIds.length) {
    io.log("[chorus init] Done. Next: run the daemon / connect MCP to activate tools.");
  }
}

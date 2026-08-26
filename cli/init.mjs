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
    io.log(`[chorus agents add] ${error}`);
    return 1;
  }
  if (!selectedIds || selectedIds.length === 0) {
    io.log("[chorus agents add] Nothing to configure.");
    return 0;
  }

  io.log(`[chorus agents add] Configuring: ${selectedIds.join(", ")}`);

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
  io.log("[chorus agents add] Summary:");
  if (outcomes.length === 0) {
    io.log("  (no steps registered yet)");
  }
  for (const o of outcomes) {
    const who = o.agentId ? `${o.agentId}` : o.stepId;
    io.log(`  - ${who}: ${o.action}${o.detail ? ` — ${o.detail}` : ""}`);
  }
  const failed = outcomes.filter(isFailureOutcome);
  if (failed.length) {
    io.log(`[chorus agents add] ${failed.length} step(s) failed — see above.`);
  } else if (selectedIds.length) {
    io.log("[chorus agents add] Done. Next: run the daemon / connect MCP to activate tools.");
  }

  profileExportHint(outcomes, io);
}

/**
 * Print an optional `export CHORUS_AGENT_PROFILE=…` hint for every agent whose
 * identity credential-seed captured. Setting it in an interactive shell lets that
 * shell's Chorus hooks/skills act as a specific agent — the CLI resolves the key
 * from ~/.chorus/daemon.json by profile, so the API key need not be exported for
 * the wrapper/doc-mirror MCP path. It is OPTIONAL and ADDITIVE (Claude Code's
 * built-in MCP client still reads CHORUS_URL/CHORUS_API_KEY from the env);
 * daemon-woken sessions receive CHORUS_AGENT_PROFILE from the spawner automatically.
 *
 * EXCEPTIONS — dsh and Claude Code: when credential-seed persisted the profile into
 * `$DSH_HOME/.env` (outcome `profileInEnv: true`) dsh loads it into the session env on
 * its own; and when it wrote the full CHORUS_* env into `~/.claude/settings.json`
 * (outcome `settingsEnvWritten: true`) Claude Code injects it at session start. Either
 * way a manual export is redundant — that agent is omitted from the hint. Every other
 * agent (Codex, Kiro, …) has no such file channel and still gets the hint.
 * @param {import("./init/contracts.mjs").StepOutcome[]} outcomes
 * @param {{ log: Function }} io
 */
export function profileExportHint(outcomes, io) {
  const seen = new Set();
  const profiles = [];
  for (const o of outcomes) {
    // dsh persists CHORUS_AGENT_PROFILE in $DSH_HOME/.env and loads it into the
    // session env itself — no manual export needed, so skip it here. Claude Code
    // likewise has its full CHORUS_* env written into ~/.claude/settings.json
    // (settingsEnvWritten) — that session is fully wired, so skip it too.
    if (o && (o.profileInEnv === true || o.settingsEnvWritten === true)) continue;
    if (o && typeof o.agentUuid === "string" && o.agentUuid && !seen.has(o.agentUuid)) {
      seen.add(o.agentUuid);
      profiles.push({ agentUuid: o.agentUuid, agentName: typeof o.agentName === "string" ? o.agentName : "" });
    }
  }
  if (profiles.length === 0) return;

  io.log("");
  io.log("[chorus agents add] Optional — act as an agent in THIS shell without exporting its API key");
  io.log("  (Chorus hooks/skills resolve the key from ~/.chorus/daemon.json by profile):");
  for (const p of profiles) {
    io.log(`    export CHORUS_AGENT_PROFILE="${p.agentUuid}"${p.agentName ? `   # ${p.agentName}` : ""}`);
  }
  io.log("  One per shell — pick the identity it should act as; add it to ~/.bashrc / ~/.zshrc");
  io.log("  to persist. Daemon-woken sessions set CHORUS_AGENT_PROFILE automatically.");
}

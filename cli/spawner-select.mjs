// cli/spawner-select.mjs
// Backend selection seam: maps the resolved agent type (daemon-agent.mjs) to a
// concrete Spawner instance. This is the ONLY place the daemon branches on the
// backend — the wake pipeline above it (queue, waker, directed delivery, headless
// guard, reporters) stays backend-agnostic and drives whichever spawner is
// injected purely through the shared wake(...) contract.
//
// The function is TOTAL: resolveAgentType has already rejected unknown values
// before this runs, so an unrecognized type here is not a user error path — we
// fall back to the safe default (claude-code) rather than throw.

import { ClaudeSpawner } from "./claude-spawner.mjs";
import { CodexSpawner } from "./codex-spawner.mjs";
import { DshSpawner } from "./dsh-spawner.mjs";
import { KiroSpawner } from "./kiro-spawner.mjs";

/**
 * Construct the spawner backend for `agentType`.
 * @param {string} agentType  "claude-code" | "codex" | "kiro" | "dsh" (already validated upstream).
 * @param {{ logger?: any, permissionMode?: "chorus"|"yolo", creds?: { url: string, apiKey: string } }} [opts]
 * @returns {import("./codex-spawner.mjs").Spawner}
 */
export function selectSpawner(agentType, opts = {}) {
  const { logger, permissionMode, creds } = opts;
  if (agentType === "codex") {
    return new CodexSpawner({ logger, permissionMode, creds });
  }
  if (agentType === "kiro") {
    return new KiroSpawner({ logger, permissionMode, creds });
  }
  if (agentType === "dsh") {
    return new DshSpawner({
      logger,
      creds,
      bundleVersion: opts.bundleVersion,
      prepareManagedConfigFn: opts.prepareManagedConfigFn,
    });
  }
  return new ClaudeSpawner({ logger, permissionMode, creds });
}

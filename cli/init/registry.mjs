// cli/init/registry.mjs
// The two seams `chorus init` runs against:
//
//   AGENT_REGISTRY — the supported coding-agent adapters. This array is the
//   single source of the supported-agent set. Task "Agent detection + per-agent
//   adapter registry" populates it; adding a new agent later = pushing one more
//   adapter here, with no change to the command core.
//
//   STEP_REGISTRY — the ordered configuration steps. This change registers the
//   credential-seed step (once) and the plugin-install step (per-agent). Sibling
//   ideas (MCP proxy cc115e6b, daemon setup a7c2a3e8) push their steps here.
//
// Both start empty and are filled by the downstream tasks; the accessor
// functions below are the stable interface runInit (cli/init.mjs) depends on,
// so the command is importable and testable at every step of the build.

import { ADAPTERS } from "./adapters.mjs";

/** @typedef {import("./contracts.mjs").AgentAdapter} AgentAdapter */
/** @typedef {import("./contracts.mjs").InitStep} InitStep */
/** @typedef {import("./contracts.mjs").AgentDetection} AgentDetection */

/**
 * Supported coding-agent adapters — the single source of the supported set.
 * Built from cli/init/adapters.mjs; add a new agent = add a descriptor there.
 * @type {AgentAdapter[]}
 */
export const AGENT_REGISTRY = [...ADAPTERS];

/**
 * Configuration steps. POPULATED by the credential-seed and plugin-install tasks.
 * @type {InitStep[]}
 */
export const STEP_REGISTRY = [];

/**
 * Run every adapter's detection and return one AgentDetection per supported agent.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {AgentDetection[]}
 */
export function detectAgents(env = process.env) {
  return AGENT_REGISTRY.map((adapter) => {
    let signals = { binaryOnPath: false, configDirPresent: false };
    try {
      signals = adapter.detect(env) || signals;
    } catch {
      // A misbehaving adapter must not break detection of the others.
    }
    return {
      id: adapter.id,
      displayName: adapter.displayName,
      binaryOnPath: !!signals.binaryOnPath,
      configDirPresent: !!signals.configDirPresent,
      detected: !!signals.binaryOnPath || !!signals.configDirPresent,
    };
  });
}

/** @param {string} id @returns {AgentAdapter | undefined} */
export function getAdapter(id) {
  return AGENT_REGISTRY.find((a) => a.id === id);
}

/**
 * The steps to run, sorted ascending by `order` (stable for equal orders).
 * @returns {InitStep[]}
 */
export function orderedSteps() {
  return STEP_REGISTRY.slice().sort((a, b) => a.order - b.order);
}

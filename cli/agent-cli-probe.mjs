// cli/agent-cli-probe.mjs
// One lookup from a daemon agent type to the resolver that finds its executable.
// Replaces the per-call-site probe ternaries in daemon.mjs (startup banner) and
// daemon-install-config.mjs (install-time PATH check), so both name the SELECTED
// backend's binary and a new backend is registered here once.
//
// Codex-family backends (codex, trae) resolve through codex-family.mjs profiles
// (resolveFamilyPath), so TRAE's `traecli` + CHORUS_TRAE_PATH come from
// CODEX_FAMILY.trae rather than a duplicated literal.

import { resolveClaudePath } from "./claude-spawner.mjs";
import { resolveCodexPath } from "./codex-spawner.mjs";
import { CODEX_FAMILY, resolveFamilyPath } from "./codex-family.mjs";
import { resolveDshPath } from "./dsh-spawner.mjs";
import { resolveKiroPath } from "./kiro-spawner.mjs";
import { resolvePiPath } from "./pi-spawner.mjs";

/** Resolve the TRAE CLI (`traecli`) executable; CHORUS_TRAE_PATH overrides. */
export function resolveTraePath(deps = {}) {
  return resolveFamilyPath(CODEX_FAMILY.trae, deps);
}

/**
 * agent type → the name of its resolver in the injectable `resolvers` bundle.
 * The names match the existing test-injection seams (`resolveCodexPath`, …).
 * Anything unlisted (claude-code, unknown) probes Claude, the default backend.
 */
const RESOLVER_KEY = Object.freeze({
  "claude-code": "resolveClaudePath",
  codex: "resolveCodexPath",
  kiro: "resolveKiroPath",
  dsh: "resolveDshPath",
  pi: "resolvePiPath",
  trae: "resolveTraePath",
});

const DEFAULT_RESOLVERS = Object.freeze({
  resolveClaudePath,
  resolveCodexPath,
  resolveKiroPath,
  resolveDshPath,
  resolvePiPath,
  resolveTraePath,
});

/**
 * Probe the executable for `agentType`. Non-throwing: returns the resolved path,
 * or null when it is not found.
 * @param {string} agentType
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, isFile?: (p: string) => boolean }} [deps]
 *   Passed through to the resolver (PATH / override discovery).
 * @param {Partial<Record<keyof typeof DEFAULT_RESOLVERS, Function|undefined>>} [resolvers]
 *   Per-backend overrides (tests). Missing / undefined entries use the defaults.
 * @returns {string | null}
 */
export function findAgentCli(agentType, deps = {}, resolvers = {}) {
  const key = Object.hasOwn(RESOLVER_KEY, agentType) ? RESOLVER_KEY[agentType] : "resolveClaudePath";
  const resolve = resolvers[key] ?? DEFAULT_RESOLVERS[key];
  return resolve(deps);
}

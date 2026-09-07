// cli/daemon-agent.mjs
// Pure resolution + validation of the daemon's `--agent <type>` selection.
// `claude-code` (the default), `codex`, `kiro`, and `dsh` are recognized backends
// (add-daemon-codex-backend cashed in the reserved `codex` slot;
// add-daemon-kiro-backend adds `kiro`). Resolving an unknown value is a hard
// error (no silent fallback).
//
// Resolution is layered like resolveSigintTimeoutMs / resolveDaemonCwds in
// daemon-config.mjs — first defined source wins:
//   --agent flag > CHORUS_AGENT env > ~/.chorus/daemon.json `agent` > claude-code.
// The config-file layer lets an operator persist a default backend (e.g.
// `"agent": "codex"`) once instead of re-passing --agent / re-exporting the env
// on every start. IO (file read) is injectable so this stays unit-testable
// without real disk.

import { readFileSync } from "node:fs";
import { loginFilePath } from "./credentials.mjs";

/** The agent backends the daemon recognizes. Existing spawners cover claude-code,
 * codex, and kiro; dsh registration is the base contract for its bridge.
 *
 * `offline` is a NON-wakeable classification, not a real backend: an agent whose
 * key is parked in daemon.json purely so `chorus mcp` can proxy through it, while
 * the daemon builds NO spawner and dispatches NO wake for it. It is accepted here
 * (and by-name in agent-backend-prompt via this list) so an agents[] entry may set
 * `agentType: "offline"` and pass resolveAgentConfigs' KNOWN_AGENTS validation. The
 * fail-closed no-wake handling lives in spawner-select.mjs (selectSpawner returns
 * an OfflineSpawner that refuses to spawn) — an offline value MUST NOT fall through
 * to the claude-code default and wake it. `chorus agents add` maps every non-wakeable
 * selected agent (opencode/openclaw) to this classification. */
export const KNOWN_AGENTS = ["claude-code", "codex", "kiro", "dsh", "pi", "offline"];

/** The default agent backend when neither --agent nor CHORUS_AGENT is set. */
export const DEFAULT_AGENT = "claude-code";

/**
 * Per-backend CLI descriptor: the executable name the daemon resolves/spawns and
 * the env var that overrides its path. Drives the startup banner's "CLI" row and
 * the not-found warning so they name the SELECTED backend (not always `claude`).
 * Unknown / undefined falls back to the default (claude-code) descriptor.
 * @param {string} agentType
 * @returns {{ name: string, envVar: string }}
 */
export function backendCli(agentType) {
  if (agentType === "codex") return { name: "codex", envVar: "CHORUS_CODEX_PATH" };
  if (agentType === "kiro") return { name: "kiro-cli", envVar: "CHORUS_KIRO_PATH" };
  if (agentType === "dsh") return { name: "dsh", envVar: "CHORUS_DSH_PATH" };
  if (agentType === "pi") return { name: "pi", envVar: "CHORUS_PI_PATH" };
  // `offline` has no CLI to resolve — it is never woken (see backendClientType).
  // The daemon does not probe a binary for it; this explicit descriptor keeps the
  // return sensible if some banner path ever reads it (CHORUS_AGENT selects the
  // backend), instead of mislabeling it as `claude`.
  if (agentType === "offline") return { name: "offline", envVar: "CHORUS_AGENT" };
  return { name: "claude", envVar: "CHORUS_CLAUDE_PATH" };
}

/**
 * Map the resolved agent backend to the `clientType` the daemon self-reports to
 * the server (and that the connection registry + presence UI display). The server
 * gates this against DAEMON_CLIENT_TYPES, so the values MUST match: `codex` →
 * `codex`, `claude-code` → `claude_code`. Anything else falls back to claude_code.
 * @param {string} agentType
 * @returns {string}
 */
export function backendClientType(agentType) {
  if (agentType === "codex") return "codex";
  if (agentType === "kiro") return "kiro";
  if (agentType === "dsh") return "dsh";
  if (agentType === "pi") return "pi";
  // `offline` is a non-wakeable classification — the daemon SHALL NOT register it
  // as a wakeable connection (daemon-multi-agent spec). It must therefore NOT
  // fall through to the `claude_code` default (which would make an offline agent
  // present as a wakeable claude_code connection). Return the distinct `offline`
  // string: the runtime fan-out skips registering it at all, and this value is
  // intentionally OUTSIDE the server's DAEMON_CLIENT_TYPES allowlist, so any
  // future path that DID try to register it fails closed (server rejects) rather
  // than silently registering it as claude_code.
  if (agentType === "offline") return "offline";
  return "claude_code";
}

/**
 * Read a JSON file, returning `null` on any error (missing / unreadable /
 * malformed). Never throws — mirrors daemon-config.mjs readJsonSafe.
 * @param {string} path
 * @returns {Record<string, unknown> | null}
 */
function readJsonSafe(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** A non-empty trimmed string, or undefined. */
function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Resolve the agent type from flag → env → config file → default, and validate it.
 * Precedence (first defined source wins, mirroring resolveSigintTimeoutMs /
 * resolveDaemonCwds): explicit `--agent` flag > CHORUS_AGENT env >
 * ~/.chorus/daemon.json `agent` > DEFAULT_AGENT.
 *
 * An unknown value from ANY source (flag, env, or file) is a hard error — no
 * silent fallback. The config file lets an operator persist a default backend
 * without re-passing --agent on every start.
 *
 * @param {{ agent?: string }} flags
 * @param {Record<string, string|undefined>} env
 * @param {{
 *   readJson?: (path: string) => (Record<string, unknown>|null),
 *   loginPath?: string,
 * }} [deps]
 * @returns {{ ok: true, agent: string } | { ok: false, value: string, error: string }}
 *   `ok:false` carries the offending value and a human-actionable error naming
 *   the accepted types — the caller exits non-zero and prints `error`.
 */
export function resolveAgentType(flags, env, deps = {}) {
  const readJson = deps.readJson ?? readJsonSafe;
  const loginPath = deps.loginPath ?? loginFilePath();

  const fromFile = () => {
    const file = readJson(loginPath);
    return file ? nonEmpty(file.agent) : undefined;
  };

  const raw =
    nonEmpty(flags.agent) ||
    nonEmpty(env.CHORUS_AGENT) ||
    fromFile() ||
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

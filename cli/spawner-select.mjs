// cli/spawner-select.mjs
// Backend selection seam: maps the resolved agent type (daemon-agent.mjs) to a
// concrete Spawner instance. This is the ONLY place the daemon branches on the
// backend — the wake pipeline above it (queue, waker, directed delivery, headless
// guard, reporters) stays backend-agnostic and drives whichever spawner is
// injected purely through the shared wake(...) contract.
//
// The function is TOTAL: resolveAgentType has already rejected unknown values
// before this runs, so an UNRECOGNIZED type here is not a user error path — we
// fall back to the safe default (claude-code) rather than throw.
//
// The `offline` type is the ONE known value that must NEVER reach that default:
// it is a non-wakeable classification (an agent parked in daemon.json only for the
// `chorus mcp` proxy key), so it gets an explicit branch returning the
// OfflineSpawner — a fail-closed no-op that logs and never spawns a subprocess.
// Without this branch, adding `offline` to KNOWN_AGENTS would let it fall through
// and silently wake Claude — the exact fail-open bug this guards against.

import { ClaudeSpawner } from "./claude-spawner.mjs";
import { CodexSpawner } from "./codex-spawner.mjs";
import { DshSpawner } from "./dsh-spawner.mjs";
import { KiroSpawner } from "./kiro-spawner.mjs";
import { PiSpawner } from "./pi-spawner.mjs";

/**
 * A fail-closed spawner for the `offline` agentType. It satisfies the shared
 * wake(...) contract so the daemon's pipeline stays backend-agnostic, but it never
 * spawns a process, never invokes `onChild` (so no server turn advances to
 * running), and never falls through to a real backend. It simply logs that the
 * agent is offline and resolves with a terminal no-op result (exitCode: null —
 * matching the "skipping wake" convention of the real backends when their CLI is
 * absent). An offline agent exists in daemon.json solely so `chorus mcp` can proxy
 * through its key; the daemon must not wake it.
 */
export class OfflineSpawner {
  /** @param {{ logger?: any }} [opts] */
  constructor({ logger } = {}) {
    this.logger = logger;
  }

  /**
   * @param {{ sessionId?: string }} [params]
   * @returns {Promise<{ sessionId: string, exitCode: null, isNew: false }>}
   */
  async wake({ sessionId } = {}) {
    this.logger?.warn?.(
      "[Chorus] agent backend is 'offline' — no local agent to wake; dropping this wake " +
        "(offline agents are proxied via `chorus mcp` only, never spawned).",
    );
    return { sessionId: sessionId ?? "", exitCode: null, isNew: false };
  }
}

/**
 * Construct the spawner backend for `agentType`.
 * @param {string} agentType  "claude-code" | "codex" | "kiro" | "dsh" | "pi" | "offline"
 *   (already validated upstream). "offline" → OfflineSpawner (fail-closed no-op).
 * @param {{ logger?: any, permissionMode?: "chorus"|"yolo", creds?: { url: string, apiKey: string } }} [opts]
 * @returns {import("./codex-spawner.mjs").Spawner}
 */
export function selectSpawner(agentType, opts = {}) {
  const { logger, permissionMode, creds } = opts;
  if (agentType === "offline") {
    // Fail-closed: an offline agent has no local backend. Return the no-op spawner
    // explicitly so we NEVER fall through to the claude-code default below and wake
    // Claude for an agent the operator classified as offline.
    return new OfflineSpawner({ logger });
  }
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
  if (agentType === "pi") {
    // pi is a first-class wakeable backend — an explicit branch so it NEVER falls
    // through to the claude-code default below (nor is treated as offline).
    return new PiSpawner({ logger, permissionMode, creds });
  }
  return new ClaudeSpawner({ logger, permissionMode, creds });
}

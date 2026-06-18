// cli/control-handler.mjs
// Daemon-side handler for reverse control commands (子3 — daemon-interrupt-resume,
// Tech Design "Architecture" / q1=a double-check). The SSE listener forks a
// `type:"control"` event here (NOT to the wake router) — see sse-listener.mjs.
//
// The single safety property this module enforces is the DOUBLE-CHECK (q1=a): act
// ONLY when BOTH hold —
//   1. event.targetConnectionUuid === this daemon's OWN registered connectionUuid, AND
//   2. the waker's in-memory execution registry holds a RUNNING child for the
//      command's `${entityType}:${entityUuid}`.
// On either mismatch the command is IGNORED and LOGGED (memory: no-silent-errors),
// so a stale / recycled connection uuid can never make the daemon kill the wrong
// subprocess (Tech Design "Risks": mis-kill after a reconnect).
//
// On a verified match it (a) sets a per-entity "interrupting" flag on the waker so
// the waker reports the resulting exit as interrupted(reason="user") rather than a
// crash, then (b) invokes the injected killer (process-killer.killProcessTree) on
// the live child. The kill is fire-and-forget from the listener's perspective; this
// handler never throws into the SSE loop.
//
// Plain ESM, zero new deps. The killer + connectionUuid getter are injected so the
// handler is unit-testable without a real subprocess or SSE stream.

import { killProcessTree } from "./process-killer.mjs";

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

/**
 * Build the `onControl(event)` callback the SseListener invokes for a
 * `type:"control"` event.
 *
 * @param {{
 *   waker: {
 *     executions: Map<string, { entityType: string, entityUuid: string, child?: any, status: string }>,
 *     markInterrupting?: (entityType: string, entityUuid: string) => void,
 *   },
 *   getConnectionUuid: () => (string|null),  This daemon's registered connection uuid
 *                                            (null until the SSE handshake reports it).
 *   killer?: (child: any, opts: any) => Promise<any>,  Injectable; defaults to killProcessTree.
 *   sigintTimeoutMs?: number,                           Layered-resolved escalation window.
 *   redispatchResume?: (entityType: string, entityUuid: string) => void,  Re-run a wake
 *                                            for a resumed entity (子3); injected by the daemon.
 *   logger?: { info(m:string):void, warn(m:string):void, error(m:string):void },
 * }} deps
 * @returns {(event: any) => void}  The onControl callback (synchronous, non-throwing).
 */
export function createControlHandler(deps) {
  const waker = deps.waker;
  const getConnectionUuid = deps.getConnectionUuid;
  const killer = deps.killer ?? killProcessTree;
  const sigintTimeoutMs = deps.sigintTimeoutMs;
  const redispatchResume = deps.redispatchResume;
  const logger = deps.logger ?? NOOP_LOGGER;

  /** Registry key for a resource — MUST match waker.#execKey. */
  const execKey = (entityType, entityUuid) => `${entityType}:${entityUuid}`;

  /**
   * Handle one control event. Synchronous + non-throwing: it performs the
   * double-check and kicks off the (async) kill fire-and-forget, returning
   * immediately so the SSE consumer never blocks. Only `command:"interrupt"` is
   * acted on; any other/unknown command is ignored + logged (forward-compatible).
   * @param {{ type?: string, command?: string, targetConnectionUuid?: string, entityType?: string, entityUuid?: string }} event
   */
  return function onControl(event) {
    try {
      if (!event || event.type !== "control") {
        logger.warn(`[Chorus] control-handler received non-control event; ignoring`);
        return;
      }
      if (event.command !== "interrupt" && event.command !== "resume") {
        // Forward-compatible: the wire enum may grow.
        logger.warn(`[Chorus] control command "${event.command}" not supported; ignoring`);
        return;
      }

      const { command, targetConnectionUuid, entityType, entityUuid } = event;

      // --- Check 1: connection-uuid match (applies to every command) ---
      const myConnectionUuid = getConnectionUuid?.() ?? null;
      if (!myConnectionUuid || targetConnectionUuid !== myConnectionUuid) {
        // Not ours (stale/recycled uuid, or handshake not yet complete). Ignore.
        logger.info(
          `[Chorus] control: ignoring ${command} for connection ${targetConnectionUuid} ` +
            `(this daemon is ${myConnectionUuid ?? "<unregistered>"})`
        );
        return;
      }

      if (typeof entityType !== "string" || typeof entityUuid !== "string") {
        logger.warn(`[Chorus] control: ${command} missing entityType/entityUuid; ignoring`);
        return;
      }

      // --- resume: re-dispatch the wake for this entity (子3). No running-child
      //     check — the subprocess is gone (it was interrupted); the wake path will
      //     re-spawn and `--resume` the existing session. ---
      if (command === "resume") {
        logger.info(`[Chorus] control: resuming ${entityType}:${entityUuid} (re-dispatch wake)`);
        try {
          redispatchResume?.(entityType, entityUuid);
        } catch (err) {
          logger.warn(`[Chorus] control: resume re-dispatch failed for ${entityType}:${entityUuid}: ${err}`);
        }
        return;
      }

      // --- interrupt path: Check 2 — in-memory entity ownership (running child) ---
      const key = execKey(entityType, entityUuid);
      const entry = waker?.executions?.get(key);
      if (!entry || entry.status !== "running" || !entry.child) {
        // Either we never ran this entity, it's only queued (no child yet), or the
        // wake already finished (race: interrupt arrived after exit). Safe no-op.
        logger.info(
          `[Chorus] control: no running subprocess for ${key} on this daemon; ignoring interrupt`
        );
        return;
      }

      // --- Both checks passed: mark interrupting (so the waker reports reason=user),
      //     then kill the tree. ---
      logger.info(`[Chorus] control: interrupting running subprocess for ${key} (pid=${entry.child.pid})`);
      try {
        waker.markInterrupting?.(entityType, entityUuid);
      } catch (err) {
        logger.warn(`[Chorus] control: markInterrupting failed for ${key}: ${err}`);
      }

      // Fire-and-forget the kill: the waker observes the child's exit and reports
      // the interrupted state. The killer never throws, but guard the promise
      // anyway so a rejection can't surface as an unhandled rejection.
      Promise.resolve(killer(entry.child, { sigintTimeoutMs, logger })).catch((err) => {
        logger.warn(`[Chorus] control: killProcessTree rejected for ${key}: ${err}`);
      });
    } catch (err) {
      // Absolute backstop — a control event must never crash the SSE loop.
      logger.error(`[Chorus] control-handler unexpected error: ${err}`);
    }
  };
}

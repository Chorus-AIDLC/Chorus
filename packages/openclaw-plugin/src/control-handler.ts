// packages/openclaw-plugin/src/control-handler.ts
// OpenClaw-host handler for reverse (server→daemon) control commands — the
// in-process analog of cli/control-handler.mjs. The SSE listener forks a
// `type:"control"` SSE event here (NOT to the wake router — see sse-listener.ts),
// so a control command can NEVER spawn a new embedded-agent run for the control
// event itself. This module is the ROUTING + DOUBLE-CHECK layer only; the actual
// abort / re-dispatch / pending-turns-sweep BEHAVIORS are injected (filled by the
// openclaw-daemon-client task, T4).
//
// The single safety property this module enforces is the DOUBLE-CHECK, identical
// to the CLI host (cli/control-handler.mjs): act ONLY when —
//   Check 1 (every command): event.targetConnectionUuid === this plugin's OWN
//            registered connectionUuid (from connection-state). On mismatch — a
//            stale/recycled uuid, another connection's command, or a handshake not
//            yet complete — IGNORE + LOG. This is what stops a recycled connection
//            uuid from aborting the wrong run (Tech Design "Risks": mis-kill after
//            a reconnect).
//   Check 2 (interrupt only): the injected `isEntityRunning(entityType, entityUuid)`
//            predicate returns true — i.e. this plugin currently holds a running
//            embedded-agent run for that entity. (In the CLI host this is "the
//            execution registry holds a running child"; here it is an injected
//            predicate the daemon client backs with its AbortController registry.)
//            On mismatch — only queued, never ran, or already finished — IGNORE + LOG.
//
// `resume` and `deliver_turn` carry NO running-entity requirement (mirroring the
// CLI host): the run for a resumed entity is already gone, and a `deliver_turn`
// resolves its turn by uuid from the persisted turn table. They only require
// Check 1.
//
// The three verbs route to injected behavior hooks (the seams T4 plugs into):
//   - interrupt    → onInterrupt(entityType, entityUuid)
//   - resume       → onResume(entityType, entityUuid)
//   - deliver_turn → onDeliverTurn(turnUuid?)   (turnUuid present = precise single
//                    turn; absent = older server, full connection sweep fallback)
//
// Non-throwing: a control event must NEVER crash the SSE loop, so the whole body
// is wrapped in a try/catch backstop and the hooks' own throws are caught + logged
// (memory: no-silent-errors — every ignore/failure is logged, never swallowed).

import type { ConnectionStateReader } from "./connection-state.js";

/**
 * The control event shape the server publishes on `control:{connectionUuid}` and
 * forwards verbatim as a `type:"control"` SSE data event. Mirrors the server's
 * `ControlEvent` (src/lib/event-bus.ts). `entityType`/`entityUuid` are present for
 * `interrupt`/`resume`; `turnUuid` is present only for `deliver_turn`.
 */
export interface ControlEvent {
  // `string` (not the `"control"` literal) because this is the raw forked SSE
  // event — the handler re-validates `type === "control"` and the command enum at
  // runtime before acting. Matches the listener's `SseControlEvent` shape so the
  // listener can pass its parsed event straight through.
  type: string;
  command?: string;
  targetConnectionUuid?: string;
  entityType?: string;
  entityUuid?: string;
  turnUuid?: string;
}

/**
 * Injected behavior hooks. These are the seams the openclaw-daemon-client task
 * (T4) fills with the real abort / re-dispatch / pending-turns-sweep. This task
 * (T3) only ROUTES verified commands to them — it does not implement the
 * behaviors. All hooks are optional so a partially-wired host (or a test) can
 * verify routing without every behavior present.
 */
export interface ControlBehaviorHooks {
  /**
   * Whether this plugin currently holds a RUNNING embedded-agent run for the
   * entity — the OpenClaw analog of the CLI host's "execution registry holds a
   * running child" check. Gates `interrupt` (Check 2). Defaults to "nothing is
   * running" (always false) when absent, so an interrupt with no registry is a
   * safe no-op rather than a blind abort.
   */
  isEntityRunning?: (entityType: string, entityUuid: string) => boolean;

  /**
   * Abort the matching in-flight run for the entity (true mid-run stop via the
   * run's AbortController). Invoked only after BOTH checks pass. (T4)
   */
  onInterrupt?: (entityType: string, entityUuid: string) => void;

  /**
   * Re-dispatch the entity's wake to continue the same session — the synthetic
   * "resume" wake. Invoked after Check 1 only (no running-entity requirement —
   * the run is gone). (T4)
   */
  onResume?: (entityType: string, entityUuid: string) => void;

  /**
   * Run the connection-scoped pending turn(s). With a `turnUuid` (origin-only
   * live delivery) run PRECISELY that one turn; without one (older server /
   * reconnect) sweep all pending turns. Invoked after Check 1 only. (T4)
   */
  onDeliverTurn?: (turnUuid?: string) => void;
}

export interface ControlHandlerOptions {
  /** Live connection identity (connection-state). Provides Check 1's "my uuid". */
  connectionState: ConnectionStateReader;
  /** Injected behavior hooks (filled by T4). */
  hooks: ControlBehaviorHooks;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

/**
 * Build the `onControl(event)` callback the SSE listener invokes for a
 * `type:"control"` event. The returned function is synchronous and non-throwing:
 * it performs the double-check and routes to the (injected) behavior hook,
 * returning immediately so the SSE consumer never blocks.
 *
 * A control event NEVER enqueues a wake or spawns a run for the control event
 * itself — that structural guarantee is owned by the SSE listener fork (the
 * control event never reaches `onEvent` / the wake router) and reinforced here
 * by routing ONLY to the abort/resume/deliver hooks, never to the wake path.
 */
export function createControlHandler(opts: ControlHandlerOptions): (event: ControlEvent) => void {
  const { connectionState, hooks, logger } = opts;
  const isEntityRunning = hooks.isEntityRunning ?? (() => false);

  return function onControl(event: ControlEvent): void {
    try {
      if (!event || event.type !== "control") {
        logger.warn(`[Chorus] control-handler received non-control event; ignoring`);
        return;
      }

      if (
        event.command !== "interrupt" &&
        event.command !== "resume" &&
        event.command !== "deliver_turn"
      ) {
        // Forward-compatible: the wire enum may grow. Unknown command → ignore + log.
        logger.warn(`[Chorus] control command "${event.command}" not supported; ignoring`);
        return;
      }

      const { command, targetConnectionUuid, entityType, entityUuid } = event;

      // --- Check 1: connection-uuid match (applies to EVERY command) ---
      const myConnectionUuid = connectionState.getConnectionUuid();
      if (!myConnectionUuid || targetConnectionUuid !== myConnectionUuid) {
        // Not ours (stale/recycled uuid, another connection, or handshake not yet
        // complete). Ignore — never abort/resume/deliver for a command that isn't ours.
        logger.info(
          `[Chorus] control: ignoring ${command} for connection ${targetConnectionUuid} ` +
            `(this plugin is ${myConnectionUuid ?? "<unregistered>"})`,
        );
        return;
      }

      // --- deliver_turn: origin-only live delivery. No entity on the wire (the
      //     turn is read by uuid) and NO running-entity requirement (mirrors
      //     resume). With a turnUuid, run PRECISELY that turn; without one (older
      //     server), the hook falls back to a full connection sweep. ---
      if (command === "deliver_turn") {
        const turnUuid = typeof event.turnUuid === "string" ? event.turnUuid : undefined;
        logger.info(
          `[Chorus] control: deliver_turn for connection ${targetConnectionUuid} ` +
            (turnUuid ? `(turn ${turnUuid})` : "(no turnUuid — full sweep fallback)"),
        );
        try {
          hooks.onDeliverTurn?.(turnUuid);
        } catch (err) {
          logger.warn(`[Chorus] control: deliver_turn hook failed: ${err}`);
        }
        return;
      }

      // interrupt / resume both target a specific entity — require both fields.
      if (typeof entityType !== "string" || typeof entityUuid !== "string") {
        logger.warn(`[Chorus] control: ${command} missing entityType/entityUuid; ignoring`);
        return;
      }

      // --- resume: re-dispatch the wake for this entity. No running-entity check —
      //     the run is gone (it was interrupted); the wake path re-enters the same
      //     session. Check 1 already passed. ---
      if (command === "resume") {
        logger.info(`[Chorus] control: resuming ${entityType}:${entityUuid} (re-dispatch wake)`);
        try {
          hooks.onResume?.(entityType, entityUuid);
        } catch (err) {
          logger.warn(
            `[Chorus] control: resume re-dispatch failed for ${entityType}:${entityUuid}: ${err}`,
          );
        }
        return;
      }

      // --- interrupt path: Check 2 — this plugin must hold a RUNNING run for the
      //     entity. The injected predicate is backed by the daemon client's
      //     AbortController registry (T4). ---
      if (!isEntityRunning(entityType, entityUuid)) {
        // Either we never ran this entity, it's only queued, or the run already
        // finished (race: interrupt arrived after completion). Safe no-op.
        logger.info(
          `[Chorus] control: no running embedded-agent run for ${entityType}:${entityUuid} ` +
            `on this plugin; ignoring interrupt`,
        );
        return;
      }

      // --- Both checks passed: route to the abort hook (true mid-run stop). ---
      logger.info(`[Chorus] control: interrupting running run for ${entityType}:${entityUuid}`);
      try {
        hooks.onInterrupt?.(entityType, entityUuid);
      } catch (err) {
        logger.warn(
          `[Chorus] control: interrupt hook failed for ${entityType}:${entityUuid}: ${err}`,
        );
      }
    } catch (err) {
      // Absolute backstop — a control event must never crash the SSE loop.
      logger.error(`[Chorus] control-handler unexpected error: ${err}`);
    }
  };
}

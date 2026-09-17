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
// When Check-2 fails for an `interrupt` (no live child here) the command is NOT
// silently dropped (fix-phantom-running-turn, Tech Design "D — a no-child interrupt
// reports the truth"): the handler logs the miss AND fire-and-forgets one
// `advanceTurn({ status: "interrupted", interruptedReason: "user" })` so a server-side
// `running` turn with no daemon child behind it converges instead of hanging forever.
// The session business key is derived without any lookup, and therefore only for the
// two control entity types where the derivation is an identity (`idea`,
// `daemon_session` → sessionId === entityUuid). `task` / `proposal` / `document` keep
// the pure-log behaviour: their session is anchored on the resource's DIRECT idea,
// which the daemon cannot resolve locally, and guessing would converge the wrong turn.
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
 * Control entity types whose session business key is the entityUuid itself, so a
 * no-child interrupt can report the turn terminal WITHOUT any REST lookup:
 *   • `idea`           — the session anchor IS the direct idea uuid.
 *   • `daemon_session` — the ad-hoc session's own business id.
 * Every other member of CONTROL_ENTITY_TYPES (`task`, `proposal`, `document`) is
 * anchored on that resource's DIRECT idea, which is not derivable locally.
 */
const SELF_ANCHORED_ENTITY_TYPES = new Set(["idea", "daemon_session"]);

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
 *   redispatchResume?: (entityType: string, entityUuid: string, resumeReason?: string,
 *                       runtimeCwd?: string, orchestrator?: object|null) => void,
 *                                            Re-run a wake for a resumed entity (子3); injected
 *                                            by the daemon. `resumeReason` ("user" | "crash",
 *                                            add-crash-execution-resume) is the row's prior
 *                                            interruptedReason from the control event — it
 *                                            selects the continue-instruction variant; absent
 *                                            or unknown degrades to the user-resume prompt.
 *   deliverTurn?: (turnUuid?: string) => void, Dispatch a PRECISE pending turn by uuid
 *                                            (子2 — origin-only live delivery). On a
 *                                            `deliver_turn` control event (after the Check-1
 *                                            connection match) the handler invokes this with
 *                                            the event's `turnUuid` so ONLY that one new
 *                                            pending `human_instruction` turn runs — not a
 *                                            connection-wide sweep that would also drag every
 *                                            other still-pending turn along. Injected by the
 *                                            daemon (`backfill.pendingTurnsOnly`); the
 *                                            arg-less form (reconnect) still sweeps all.
 *   advanceTurn?: (params: { sessionId: string, status: string, interruptedReason?: string,
 *                            entityType?: string|null, entityUuid?: string|null }) => any,
 *                                            The SAME `createTurnReporter(...)` instance the
 *                                            waker uses (injected by `cli/daemon.mjs`; no
 *                                            second transport, no new endpoint). Invoked
 *                                            fire-and-forget ONLY when an `interrupt` finds no
 *                                            live child for a self-anchored entity type, to
 *                                            close a server-side `running` turn that nothing
 *                                            else would ever close.
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
  const deliverTurn = deps.deliverTurn;
  const advanceTurn = deps.advanceTurn;
  const handleDirectoryRequest = deps.handleDirectoryRequest;
  const reportDirectoryRequest = deps.reportDirectoryRequest;
  const logger = deps.logger ?? NOOP_LOGGER;

  /** Registry key for a resource — MUST match waker.#execKey. */
  const execKey = (entityType, entityUuid) => `${entityType}:${entityUuid}`;

  /**
   * Handle one control event. Synchronous + non-throwing: it performs the
   * double-check and kicks off the (async) kill fire-and-forget, returning
   * immediately so the SSE consumer never blocks. `interrupt` (kill), `resume`
   * (re-dispatch wake), and `deliver_turn` (origin-only live delivery — trigger the
   * pending-turns sweep) are acted on; any other/unknown command is ignored + logged
   * (forward-compatible).
   * @param {{ type?: string, command?: string, targetConnectionUuid?: string, entityType?: string, entityUuid?: string }} event
   */
  return function onControl(event) {
    try {
      if (!event || event.type !== "control") {
        logger.warn(`[Chorus] control-handler received non-control event; ignoring`);
        return;
      }
      if (
        event.command !== "interrupt" &&
        event.command !== "resume" &&
        event.command !== "deliver_turn" &&
        event.command !== "browse_directory"
      ) {
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

      if (command === "browse_directory") {
        const requestUuid = event.requestUuid;
        if (typeof requestUuid !== "string" || !requestUuid) {
          logger.warn("[Chorus] control: browse_directory missing requestUuid; ignoring");
          return;
        }
        Promise.resolve()
          .then(() => handleDirectoryRequest?.(event))
          .then((result) => reportDirectoryRequest?.({
            requestUuid,
            status: "succeeded",
            ...result,
          }))
          .catch((err) => reportDirectoryRequest?.({
            requestUuid,
            status: "failed",
            errorCode: err?.code ?? "INTERNAL_ERROR",
          }))
          .catch((err) => logger.warn(`[Chorus] control: directory report failed: ${err}`));
        return;
      }

      // --- deliver_turn: origin-only live delivery (子2). The session's origin connection
      //     (THIS one — Check 1 passed) was pinged that a SPECIFIC new pending
      //     `human_instruction` turn (`event.turnUuid`) awaits. Dispatch ONLY that turn — not
      //     a connection-wide sweep, which would also drag every other still-pending turn of
      //     this connection along (the multi-wake bug). No entity is carried on the wire (the
      //     turn is read by uuid), and there is NO running-child requirement (mirrors
      //     `resume`); the read resolves the text from the persisted turn. Idempotent with
      //     reconnect backfill via the shared `seen` set (key turn:{uuid}). A `deliver_turn`
      //     missing `turnUuid` (older server) falls back to the full sweep so it still runs. ---
      if (command === "deliver_turn") {
        const turnUuid = typeof event.turnUuid === "string" ? event.turnUuid : undefined;
        logger.info(
          `[Chorus] control: deliver_turn for connection ${targetConnectionUuid} ` +
            (turnUuid ? `(turn ${turnUuid})` : "(no turnUuid — full sweep fallback)"),
        );
        try {
          deliverTurn?.(turnUuid);
        } catch (err) {
          logger.warn(`[Chorus] control: deliver_turn failed: ${err}`);
        }
        return;
      }

      if (typeof entityType !== "string" || typeof entityUuid !== "string") {
        logger.warn(`[Chorus] control: ${command} missing entityType/entityUuid; ignoring`);
        return;
      }

      // --- resume: re-dispatch the wake for this entity (子3). No running-child
      //     check — the subprocess is gone (it was interrupted); the wake path will
      //     re-spawn and `--resume` the existing session. `resumeReason` (the row's
      //     prior interruptedReason, add-crash-execution-resume) is threaded through
      //     so the wake prompt can state a crash explicitly; anything but the two
      //     known values (or an older server sending none) degrades to undefined →
      //     the existing user-resume prompt. ---
      if (command === "resume") {
        const resumeReason =
          event.resumeReason === "user" || event.resumeReason === "crash"
            ? event.resumeReason
            : undefined;
        logger.info(
          `[Chorus] control: resuming ${entityType}:${entityUuid} (re-dispatch wake` +
            (resumeReason ? `, reason=${resumeReason}` : "") +
            `)`
        );
        try {
          if (
            (typeof event.runtimeCwd === "string" && event.runtimeCwd) ||
            event.orchestrator != null
          ) {
            redispatchResume?.(
              entityType,
              entityUuid,
              resumeReason,
              typeof event.runtimeCwd === "string" ? event.runtimeCwd : undefined,
              event.orchestrator ?? null,
            );
          } else {
            redispatchResume?.(entityType, entityUuid, resumeReason);
          }
        } catch (err) {
          logger.warn(`[Chorus] control: resume re-dispatch failed for ${entityType}:${entityUuid}: ${err}`);
        }
        return;
      }

      // --- interrupt path: Check 2 — in-memory entity ownership (running child) ---
      //
      // The registry is keyed by the WAKE's own resource (`task:T`), while a
      // conversation's control key is its session anchor (`idea:A`). A wake on a CHILD
      // resource of idea A runs on session A (waker: `sessionId = directIdeaUuid`), so an
      // `idea:A` interrupt must also find a running `task:T` / `proposal:P` / `document:D`
      // entry whose `directIdeaUuid` is A — the same rule the UI's `executionMatchesSession`
      // applies. Without this the exact-key lookup misses, we report a turn miss, the
      // server's FIFO resolution grabs the SIBLING wake's `running` turn, and NOTHING is
      // killed: the UI would say interrupted while the agent keeps working.
      const key = execKey(entityType, entityUuid);
      let entry = waker?.executions?.get(key);
      // The entity the kill actually targets — normally the command's own, but a sibling
      // wake when the match below re-points it.
      let killEntityType = entityType;
      let killEntityUuid = entityUuid;
      let killKey = key;
      if ((!entry || entry.status !== "running" || !entry.child) && entityType === "idea") {
        for (const candidate of waker?.executions?.values() ?? []) {
          if (
            candidate.status === "running" &&
            candidate.child &&
            candidate.directIdeaUuid === entityUuid
          ) {
            killEntityType = candidate.entityType;
            killEntityUuid = candidate.entityUuid;
            killKey = execKey(killEntityType, killEntityUuid);
            logger.info(
              `[Chorus] control: no direct child for ${key}, but sibling wake ${killKey} ` +
                `runs on this session; interrupting that instead`
            );
            entry = candidate;
            break;
          }
        }
      }
      if (!entry || entry.status !== "running" || !entry.child) {
        // Either we never ran this entity, it's only queued (no child yet), or the
        // wake already finished (race: interrupt arrived after exit). There is nothing
        // to kill — but the SERVER may still hold a `running` turn for this session
        // that nothing else will ever close (the phantom-running-turn bug). Report it
        // terminal so the UI converges. Only for the self-anchored entity types; for
        // the rest we cannot know the session locally, so keep the old pure log.
        if (SELF_ANCHORED_ENTITY_TYPES.has(entityType)) {
          logger.info(
            `[Chorus] control: no running subprocess for ${key} on this daemon; ` +
              `reporting the turn as interrupted(user)`
          );
          // Fire-and-forget: createTurnReporter never throws and logs its own
          // failures, but guard both the synchronous throw and the rejection so
          // nothing escapes into the SSE loop. A server with no `running` turn
          // answers not_found — a harmless no-op (losing race).
          try {
            Promise.resolve(
              advanceTurn?.({
                sessionId: entityUuid,
                status: "interrupted",
                interruptedReason: "user",
                entityType,
                entityUuid,
              })
            ).catch((err) => {
              logger.warn(
                `[Chorus] control: interrupted-turn report rejected for ${key}: ${err}`
              );
            });
          } catch (err) {
            logger.warn(`[Chorus] control: interrupted-turn report failed for ${key}: ${err}`);
          }
          return;
        }
        logger.info(
          `[Chorus] control: no running subprocess for ${key} on this daemon; ignoring interrupt`
        );
        return;
      }

      // --- Both checks passed: mark interrupting (so the waker reports reason=user),
      //     then kill the tree. ---
      logger.info(`[Chorus] control: interrupting running subprocess for ${killKey} (pid=${entry.child.pid})`);
      try {
        // Flag the entity whose wake we are actually killing — a sibling re-point must
        // mark THAT wake interrupting, or its exit would be reported as a crash.
        waker.markInterrupting?.(killEntityType, killEntityUuid);
      } catch (err) {
        logger.warn(`[Chorus] control: markInterrupting failed for ${killKey}: ${err}`);
      }

      // Fire-and-forget the kill: the waker observes the child's exit and reports
      // the interrupted state. The killer never throws, but guard the promise
      // anyway so a rejection can't surface as an unhandled rejection.
      Promise.resolve(killer(entry.child, { sigintTimeoutMs, logger })).catch((err) => {
        logger.warn(`[Chorus] control: killProcessTree rejected for ${killKey}: ${err}`);
      });
    } catch (err) {
      // Absolute backstop — a control event must never crash the SSE loop.
      logger.error(`[Chorus] control-handler unexpected error: ${err}`);
    }
  };
}

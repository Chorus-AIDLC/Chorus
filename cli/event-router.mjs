// cli/event-router.mjs
// Routes incoming SSE notification events to wakes. Plain ESM adaptation of
// packages/openclaw-plugin/src/event-router.ts — but instead of OpenClaw's
// runEmbeddedAgent, it enqueues onto the per-root-idea WakeQueue so the daemon
// spawns headless Claude with correct serialization.
//
// Flow: SSE `new_notification` → fetch full detail via MCP → if it's a wake
// action, resolve the root-idea key and enqueue the wake. Never throws into the
// SSE loop.

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

export class EventRouter {
  /**
   * @param {{
   *   mcpClient: { callTool: (name: string, args?: Record<string, unknown>) => Promise<any> },
   *   waker: { keyFor: (n: any) => Promise<{ key: string, rootIdeaUuid: string|null, directIdeaUuid: string|null }>, wake: (n: any, key: string, attribution?: any) => Promise<void>, markQueued?: (n: any, key: string, attribution?: any) => void },
   *   queue: { enqueue: (key: string, task: () => Promise<void>) => void },
   *   wakeActions: Set<string>,
   *   logger?: { info(m:string):void, warn(m:string):void, error(m:string):void },
   * }} opts
   */
  constructor(opts) {
    this.mcp = opts.mcpClient;
    this.waker = opts.waker;
    this.queue = opts.queue;
    this.wakeActions = opts.wakeActions;
    this.logger = opts.logger ?? NOOP_LOGGER;
    // Shared dedup set: the daemon passes the SAME Set to the reconnect backfill
    // so a notification handled live is never re-woken on reconnect, and a
    // duplicate live delivery is dropped. Keyed by notificationUuid, marked at
    // dispatch time (before any async work) so concurrent dispatches for the
    // same uuid collapse to one wake.
    this.seen = opts.seen ?? new Set();
  }

  /**
   * Handle one SSE event. Synchronous + non-throwing: it kicks off async
   * fetch/route work and returns immediately so the SSE consumer never blocks.
   * @param {{ type?: string, notificationUuid?: string }} event
   */
  dispatch(event) {
    if (event?.type !== "new_notification") {
      return; // count_update etc. — ignore quietly
    }
    if (!event.notificationUuid) {
      this.logger.warn("[Chorus] new_notification missing notificationUuid, skipping");
      return;
    }
    if (this.seen.has(event.notificationUuid)) {
      return; // already handled (e.g. live delivery then reconnect backfill)
    }
    this.seen.add(event.notificationUuid);
    this.#fetchAndRoute(event.notificationUuid).catch((err) => {
      this.logger.error(`[Chorus] failed to route notification ${event.notificationUuid}: ${err}`);
    });
  }

  /** @param {string} notificationUuid */
  async #fetchAndRoute(notificationUuid) {
    const result = await this.mcp.callTool("chorus_get_notifications", {
      status: "unread",
      limit: 50,
      autoMarkRead: false,
    });
    const notifications = result?.notifications;
    if (!Array.isArray(notifications)) {
      this.logger.warn("[Chorus] could not fetch notifications list");
      return;
    }
    const n = notifications.find((x) => x?.uuid === notificationUuid);
    if (!n) {
      this.logger.warn(`[Chorus] notification ${notificationUuid} not in unread list`);
      return;
    }
    if (!this.wakeActions.has(n.action)) {
      this.logger.info(`[Chorus] action "${n.action}" is not a wake action — ignoring`);
      return;
    }

    // 子2 — daemon-instruction-injection: a `human_instruction` is NOT woken from the
    // notification path. Its live delivery is the origin-only `deliver_turn` control ping
    // (precise `turnUuid` → pending-turns sweep), and its recovery is the reconnect
    // pending-turn backfill — BOTH keyed on `turn:{uuid}` in the shared `seen` set. The
    // `new_notification` SSE event ALSO arrives here (the action is in WAKE_ACTIONS so the
    // reconnect notification backfill can re-derive autonomous wakes), but acting on it
    // here would run the SAME instruction a SECOND time under a DIFFERENT dedup key
    // (`notificationUuid` vs `turn:{uuid}`) — the double-execution bug — and would fan the
    // wake out to EVERY connection of the agent rather than the session's origin. So the
    // notification path explicitly defers `human_instruction` to the turn-keyed paths.
    if (n.action === "human_instruction") {
      this.logger.info(
        `[Chorus] human_instruction ${notificationUuid} is delivered via deliver_turn / pending-turn backfill — not the notification path; ignoring here`
      );
      return;
    }

    await this.#resolveAndEnqueue(n, notificationUuid);
  }

  /**
   * Re-dispatch a RESUME (子3 — daemon-interrupt-resume): the reverse control
   * channel delivered a `command:"resume"` for an entity, so re-run its wake. Unlike
   * a notification this is NOT fetched from the unread list and has no
   * notificationUuid — it is a synthetic, entity-generic `resource_resumed` wake.
   * It flows through the SAME keyFor → markQueued → enqueue path as any wake, so the
   * per-direct-idea serialization holds and the spawner's on-disk transcript probe
   * naturally selects `claude --resume <directIdeaUuid>` (the session already
   * exists). Synchronous + non-throwing, mirroring `dispatch`.
   * @param {{ entityType?: string, entityUuid?: string }} target
   */
  dispatchResume(target) {
    const entityType = target?.entityType;
    const entityUuid = target?.entityUuid;
    if (typeof entityType !== "string" || typeof entityUuid !== "string" || !entityUuid) {
      this.logger.warn("[Chorus] resume dispatch missing entityType/entityUuid, skipping");
      return;
    }
    const n = { action: "resource_resumed", entityType, entityUuid };
    this.#resolveAndEnqueue(n, `resume:${entityType}:${entityUuid}`).catch((err) => {
      this.logger.error(`[Chorus] failed to dispatch resume for ${entityType}:${entityUuid}: ${err}`);
    });
  }

  /**
   * Re-dispatch a backfilled PENDING TURN (子1 — daemon-session-conversation). On
   * reconnect, the backfill re-derives unstarted turns from the TURN TABLE (the
   * canonical source — see backfill.mjs) rather than from a possibly-lost notification
   * ping, so a dropped delivery never loses an instruction. Each pending turn already
   * carries its session anchor (`sessionId` + `directIdeaUuid`) and — for a
   * `human_instruction` — its canonical free-text body (`promptText`). We re-run it
   * through the SAME markQueued → enqueue path as a live wake, BUT skip `keyFor`'s
   * lineage round-trip: the session key is reconstructed DIRECTLY from the turn's
   * own ids (which are authoritative), so backfill needs no network beyond the
   * pending-turns read. Deduped via the shared `seen` set keyed on the turn uuid so a
   * pending turn already handled live (or by an earlier backfill) is not re-run.
   * Synchronous + non-throwing, mirroring `dispatch`/`dispatchResume`.
   *
   * Only `human_instruction` pending turns are re-dispatched here: autonomous turns
   * (task_assigned / mentioned / elaboration / resume) are re-driven by the
   * notification backfill (their notifications are re-fetched), whereas a
   * human_instruction's actionable payload lives ONLY on the turn — so the turn table
   * is its sole reliable backfill source.
   *
   * @param {{ turnUuid?: string, sessionId?: string, directIdeaUuid?: string|null,
   *           trigger?: string, promptText?: string|null }} pending
   */
  dispatchPendingTurn(pending) {
    const turnUuid = pending?.turnUuid;
    const sessionId = pending?.sessionId;
    if (typeof turnUuid !== "string" || !turnUuid) {
      this.logger.warn("[Chorus] pending-turn dispatch missing turnUuid, skipping");
      return;
    }
    if (typeof sessionId !== "string" || !sessionId) {
      this.logger.warn(`[Chorus] pending-turn ${turnUuid} missing sessionId, skipping`);
      return;
    }
    // Only human_instruction is re-derived from the turn table (see doc above).
    if (pending.trigger !== "human_instruction") {
      return;
    }
    const instruction =
      typeof pending.promptText === "string" ? pending.promptText.trim() : "";
    if (!instruction) {
      this.logger.warn(
        `[Chorus] pending human_instruction turn ${turnUuid} has no promptText — skipping`
      );
      return;
    }
    // Shared dedup: a turn uuid keys the seen set so a backfilled pending turn already
    // handled (live or earlier backfill) does not re-run. Marked BEFORE async work, as
    // the live path does, so concurrent backfills collapse to one wake.
    const seenKey = `turn:${turnUuid}`;
    if (this.seen.has(seenKey)) return;
    this.seen.add(seenKey);

    const directIdeaUuid =
      typeof pending.directIdeaUuid === "string" ? pending.directIdeaUuid : null;
    // Reconstruct the wake's session anchor DIRECTLY from the turn's own ids (no
    // lineage round-trip). The waker anchors the Claude session on
    // `directIdeaUuid ?? entityUuid`, and the per-direct-idea queue keys on the same —
    // so set entityUuid = sessionId so both align with the canonical session.
    //
    // Execution entity (子3 follow-up): an idea-anchored conversation reports its
    // execution against the real idea (`idea:<directIdeaUuid>` — a valid entity); an
    // AD-HOC conversation has no content entity, so it reports against the conversation
    // itself (`daemon_session:<sessionId>`). Previously the ad-hoc branch reported
    // `task:<sessionId>`, which the server DROPS (no Task with that uuid) — so the
    // running/interrupt state never reached the UI. Because the ad-hoc anchor IS the
    // sessionId, the execution entityUuid, the Claude `--resume` anchor, and the
    // per-session UI match key are all the same value.
    const n = {
      action: "human_instruction",
      // The session business key IS the entity anchor here: directIdeaUuid for an
      // idea-anchored session, else the ad-hoc session id (the original entity uuid).
      entityType: directIdeaUuid ? "idea" : "daemon_session",
      entityUuid: directIdeaUuid ? directIdeaUuid : sessionId,
      instructionText: instruction,
    };
    const key = directIdeaUuid ? `idea:${directIdeaUuid}` : `entity:daemon_session:${sessionId}`;
    const attribution = { key, rootIdeaUuid: directIdeaUuid, directIdeaUuid };

    // Mark queued (snapshot) then enqueue on the same per-direct-idea lane as a live
    // wake — non-throwing so a missing/failed hook never breaks backfill.
    try {
      this.waker.markQueued?.(n, key, attribution);
    } catch (err) {
      this.logger.warn(`[Chorus] markQueued failed for pending turn ${turnUuid}: ${err}`);
    }
    this.queue.enqueue(key, () => this.waker.wake(n, key, attribution));
  }

  /**
   * Resolve a wake's serialization key + idea attribution, mark it queued, and
   * enqueue it on the per-direct-idea queue. Shared by the notification path
   * (`#fetchAndRoute`) and the resume re-dispatch (`dispatchResume`). `label` is a
   * human-readable id for logs (a notificationUuid, or a synthetic resume label).
   * keyFor may hit the network (lineage), so it runs before enqueue; the wake itself
   * runs on the queue. `attribution` carries both the direct idea (session anchor, in
   * the key) and the resolved root idea (for the snapshot), threaded explicitly so
   * the snapshot's root is never derived from the direct-idea key.
   * @param {any} n  A notification (or synthetic resume) with at least action +
   *                 entityType + entityUuid.
   * @param {string} label
   */
  async #resolveAndEnqueue(n, label) {
    let key;
    let attribution;
    try {
      const resolved = await this.waker.keyFor(n);
      key = resolved.key;
      attribution = resolved;
    } catch (err) {
      this.logger.warn(`[Chorus] could not resolve wake key for ${label}: ${err}`);
      return;
    }
    // Mark the resource queued (emits a snapshot) BEFORE enqueue, so the server
    // sees it waiting even while it sits behind a same-direct-idea wake. Optional +
    // non-throwing so a missing/failed hook never breaks routing.
    try {
      this.waker.markQueued?.(n, key, attribution);
    } catch (err) {
      this.logger.warn(`[Chorus] markQueued failed for ${label}: ${err}`);
    }
    this.queue.enqueue(key, () => this.waker.wake(n, key, attribution));
  }
}

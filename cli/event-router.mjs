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

// Map a Notification.action to its DaemonSessionTurn trigger category — the daemon-side
// MIRROR of the server's NOTIFICATION_ACTION_TO_TURN_TRIGGER (src/services/notification-turn.ts).
// Used ONLY to match a re-read wake notification back to a DIRECTED autonomous pending turn
// (the deliver_turn re-dispatch rebuilds the prompt from the notification, T2). Kept narrow
// to the dedicated triggers a `deliver_turn` ping can carry for an autonomous wake; every
// other action collapses to the `task_assigned` trigger exactly as the server does, so a
// task_assigned turn matches its task_reopened/task_verified/idea_claimed/proposal_* origins.
const ACTION_TO_TURN_TRIGGER = {
  mentioned: "mentioned",
  elaboration_verified: "elaboration_verified",
  start_development: "start_development",
  yolo_requested: "yolo_requested",
  elaboration_requested: "elaboration",
  elaboration_answered: "elaboration",
  human_instruction: "human_instruction",
  task_assigned: "task_assigned",
  task_reopened: "task_assigned",
  task_verified: "task_assigned",
  idea_claimed: "task_assigned",
  proposal_approved: "task_assigned",
  proposal_rejected: "task_assigned",
};

export class EventRouter {
  /**
   * @param {{
   *   mcpClient: { callTool: (name: string, args?: Record<string, unknown>) => Promise<any> },
   *   waker: { keyFor: (n: any) => Promise<{ key: string, rootIdeaUuid: string|null, directIdeaUuid: string|null }>, wake: (n: any, key: string, attribution?: any) => Promise<void>, markQueued?: (n: any, key: string, attribution?: any) => void },
   *   queue: { enqueue: (key: string, task: () => Promise<void>) => void },
   *   wakeActions: Set<string>,
   *   getConnectionUuid?: () => (string|null),  This daemon's registered connection uuid
   *                                             (null until the SSE handshake reports it).
   *                                             Same self-identity source the control handler
   *                                             uses — wired in cli/daemon.mjs. Used to suppress
   *                                             a DIRECTED (pinned) wake whose stamped target is
   *                                             NOT this connection (fix-pinned-wake-directed-
   *                                             delivery). Absent ⇒ no targeting (no suppression
   *                                             ever) — preserves the pre-change behavior for any
   *                                             caller that does not wire it.
   *   logger?: { info(m:string):void, warn(m:string):void, error(m:string):void },
   * }} opts
   */
  constructor(opts) {
    this.mcp = opts.mcpClient;
    this.waker = opts.waker;
    this.queue = opts.queue;
    this.wakeActions = opts.wakeActions;
    // This daemon's own connection uuid (lazy — read at routing time, not construction,
    // since the SSE handshake assigns it after the router is built). Defaults to a getter
    // returning null so an un-wired router behaves as before (a stamped target is then
    // never "mine", but only `human_instruction`/directed paths stamp one — un-pinned wakes
    // carry no target and are unaffected).
    this.getConnectionUuid = opts.getConnectionUuid ?? (() => null);
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
   *
   * DIRECTED-DELIVERY TRANSPORT FIELDS (fix-pinned-wake-directed-delivery): a live
   * `new_notification` event for a PINNED autonomous wake carries two TRANSPORT-ONLY fields
   * stamped by the server (NOT persisted, NOT on `chorus_get_notifications`):
   *   - `targetConnectionUuid` — the resolved ONLINE target connection for a directed wake;
   *     null for un-pinned / notify-only wakes.
   *   - `suppressWake` — true ONLY for an offline-pin wake (a pin matched NO online
   *     connection) so EVERY daemon suppresses (Q2 notify-only); false otherwise.
   * They are threaded to `#fetchAndRoute` so the broadcast-suppression decision can be made
   * there. A reconnect-backfill synthetic event omits both (so a backfilled wake behaves as
   * un-pinned → online-first; the directed target is covered by its own `deliver_turn` ping).
   * @param {{ type?: string, notificationUuid?: string, targetConnectionUuid?: string|null, suppressWake?: boolean }} event
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
    // Snapshot the transport-only directed-delivery fields off the EVENT (NOT the fetched
    // notification — the server stamps them on the SSE envelope only).
    const targetConnectionUuid =
      typeof event.targetConnectionUuid === "string" ? event.targetConnectionUuid : null;
    const suppressWake = event.suppressWake === true;
    this.#fetchAndRoute(event.notificationUuid, { targetConnectionUuid, suppressWake }).catch(
      (err) => {
        this.logger.error(`[Chorus] failed to route notification ${event.notificationUuid}: ${err}`);
      }
    );
  }

  /**
   * @param {string} notificationUuid
   * @param {{ targetConnectionUuid?: string|null, suppressWake?: boolean }} [transport]
   *   Transport-only directed-delivery fields snapshotted off the SSE event (see `dispatch`).
   *   Omitted/empty (e.g. reconnect backfill) ⇒ un-pinned behavior (no suppression).
   */
  async #fetchAndRoute(notificationUuid, transport = {}) {
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

    // DIRECTED-DELIVERY BROADCAST SUPPRESSION (fix-pinned-wake-directed-delivery, T2). The
    // notification SSE stream is per-AGENT, so EVERY online (host, cwd) connection of the
    // agent receives the same `new_notification`. A pinned autonomous wake (mention /
    // task_assigned / elaboration_verified resolved to a specific online instance) must wake
    // ONLY that instance — the others must ignore their broadcast copy. The decision uses the
    // transport-only fields the server stamped on THIS event (read in `dispatch`):
    //
    //   1. suppressWake === true → OFFLINE-PIN (Q2): a real pin matched NO online connection.
    //      Wake NO instance, agent-wide, even though this connection may be online and would
    //      otherwise broadcast→online-first. This is the ONE place that realizes the design's
    //      "no online target → every connection suppresses → notify-only" intent. Without this
    //      explicit flag an offline-pin is indistinguishable from an un-pinned wake (both carry
    //      targetConnectionUuid:null) and would be silently re-woken — the bug this guards.
    //
    //   2. targetConnectionUuid set AND !== my connection uuid → a DIRECTED wake for a
    //      DIFFERENT instance. Suppress: the resolved target wakes from its own copy (and via
    //      the precise deliver_turn ping); this connection must not also wake (the agent-wide
    //      fan-out is the headline bug). Pre-handshake (my uuid still null) counts as "not mine"
    //      → suppress, since this daemon cannot prove it is the target; delivery to the actual
    //      target is covered by the deliver_turn ping + reconnect pending-turn backfill.
    //
    //   3. targetConnectionUuid set AND === my connection uuid → I am the resolved target →
    //      wake (acting on this broadcast copy, which carries the full prompt context). The
    //      target's own deliver_turn→pending-turn delivery is deduped against this via the
    //      shared `seen` set (the pending re-dispatch keys turn:{uuid}; whichever runs first
    //      marks the other seen) so the target wakes exactly ONCE.
    //
    //   4. no target AND not suppressed → UN-PINNED (or a fully-offline `none` agent): wake
    //      exactly as before this change (broadcast → online-first). BYTE-IDENTICAL — the path
    //      below is untouched for this case.
    if (transport.suppressWake === true) {
      this.logger.info(
        `[Chorus] wake ${notificationUuid} (${n.action}) is an OFFLINE-PIN (pin matched no online instance) — notify-only, suppressing wake on every connection`
      );
      return;
    }
    const target =
      typeof transport.targetConnectionUuid === "string" ? transport.targetConnectionUuid : null;
    if (target) {
      const me = this.getConnectionUuid();
      if (target !== me) {
        this.logger.info(
          `[Chorus] wake ${notificationUuid} (${n.action}) is directed to connection ${target}` +
            ` — not this daemon (${me ?? "<unregistered>"}); suppressing broadcast wake`
        );
        return;
      }
      // target === me: I am the resolved target — fall through and wake (deduped below).
      this.logger.info(
        `[Chorus] wake ${notificationUuid} (${n.action}) is directed to THIS connection (${me}) — waking`
      );
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
   *
   * `resumeReason` (add-crash-execution-resume) is the interrupted row's prior
   * reason ("user" | "crash") threaded from the control event; it is stamped on the
   * synthetic notification as `resumedFrom` so the prompt builder can state a crash
   * explicitly. Absent/unknown → not stamped → the user-resume prompt.
   * @param {{ entityType?: string, entityUuid?: string, resumeReason?: string }} target
   */
  dispatchResume(target) {
    const entityType = target?.entityType;
    const entityUuid = target?.entityUuid;
    if (typeof entityType !== "string" || typeof entityUuid !== "string" || !entityUuid) {
      this.logger.warn("[Chorus] resume dispatch missing entityType/entityUuid, skipping");
      return;
    }
    const resumedFrom =
      target?.resumeReason === "user" || target?.resumeReason === "crash"
        ? target.resumeReason
        : undefined;
    const n = {
      action: "resource_resumed",
      entityType,
      entityUuid,
      ...(resumedFrom ? { resumedFrom } : {}),
    };
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
   * DELIVERY SCOPE (fix-pinned-wake-directed-delivery, T2 — widened): a `deliver_turn` ping
   * now also fires for a DIRECTED autonomous wake (`mentioned` / `task_assigned` /
   * `elaboration_verified`), so this entrypoint re-dispatches those too — not only
   * `human_instruction`. Unlike `human_instruction`, an autonomous turn has
   * `promptText = null` (only human_instruction carries canonical free text), so its wake
   * prompt CANNOT be rebuilt from the turn — it is rebuilt from the wake NOTIFICATION
   * (re-read via `chorus_get_notifications`) for the turn's session. See the
   * `#redispatchAutonomousTurn` helper.
   *
   * DEDUP (the two delivery routes for a DIRECTED target collapse to ONE wake): the
   * target's BROADCAST copy (handled in `#fetchAndRoute`, keyed `notificationUuid` in the
   * shared `seen` set when `target === me`) and THIS `deliver_turn`→pending delivery (keyed
   * `turn:{uuid}`) both reach the target. They share the same `seen` set; the autonomous
   * re-dispatch additionally marks the MATCHED notification's `notificationUuid` so whichever
   * route runs first claims the other's key, and the second is dropped — exactly once.
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
    // A DIRECTED autonomous turn (mentioned / task_assigned / elaboration_verified /
    // start_development / yolo_requested) is delivered by the deliver_turn ping too (T2).
    // Its prompt must be rebuilt from the notification (promptText is null), so it takes a
    // separate async path. resume / elaboration are not delivered by deliver_turn (resume
    // is synthetic; elaboration request/answer rides the notification broadcast), so they
    // are not re-dispatched here.
    if (
      pending.trigger === "mentioned" ||
      pending.trigger === "task_assigned" ||
      pending.trigger === "elaboration_verified" ||
      pending.trigger === "start_development" ||
      pending.trigger === "yolo_requested"
    ) {
      // Shared dedup, marked BEFORE async work (mirrors the human_instruction path and
      // `dispatch`) so concurrent deliveries collapse to one wake.
      const seenKey = `turn:${turnUuid}`;
      if (this.seen.has(seenKey)) return;
      this.seen.add(seenKey);
      const directIdeaUuid =
        typeof pending.directIdeaUuid === "string" ? pending.directIdeaUuid : null;
      this.#redispatchAutonomousTurn({
        turnUuid,
        sessionId,
        directIdeaUuid,
        trigger: pending.trigger,
      }).catch((err) => {
        this.logger.error(
          `[Chorus] failed to re-dispatch autonomous pending turn ${turnUuid}: ${err}`
        );
      });
      return;
    }
    // Only human_instruction is re-derived from the turn table directly (see doc above).
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
   * Re-dispatch a DIRECTED autonomous pending turn (mentioned / task_assigned /
   * elaboration_verified) delivered by the `deliver_turn` ping (T2 — fix-pinned-wake-
   * directed-delivery). Unlike `human_instruction`, the turn carries `promptText = null`,
   * so the wake prompt must be rebuilt from the wake NOTIFICATION — `buildPrompt` (run
   * inside `waker.wake`) needs `entityType` / `entityUuid` / `entityTitle` / `actorName` /
   * `message`, none of which live on the turn. We re-read the unread notifications (the
   * same `chorus_get_notifications` the router already uses) and pick the wake notification
   * for THIS turn's session + trigger.
   *
   * PROMPT-CONTEXT CONSTRAINT (Tech Design): in the normal live case the target is online,
   * so it ALSO received the broadcast — which `#fetchAndRoute` already woke (and marked the
   * notification `seen`). This path then finds that notification already `seen` and dedups
   * away → exactly one wake. In the rare missed-broadcast case (the ping arrived but the
   * broadcast copy did not), this path is the one that wakes, with the prompt rebuilt from
   * the re-read notification. If no matching unread notification exists at all (e.g. it was
   * already read), there is no autonomous context to rebuild — log and skip (the durable
   * net is the reconnect notification backfill, which re-derives autonomous wakes).
   *
   * DEDUP across the two routes: this matched notification's `uuid` is the SAME key the
   * broadcast path marks in the shared `seen` set, so whichever route runs first claims it
   * and the other is dropped. The `turn:{uuid}` key was already marked by the caller.
   *
   * @param {{ turnUuid: string, sessionId: string, directIdeaUuid: string|null, trigger: string }} pending
   */
  async #redispatchAutonomousTurn(pending) {
    const { turnUuid, sessionId, directIdeaUuid, trigger } = pending;
    let result;
    try {
      result = await this.mcp.callTool("chorus_get_notifications", {
        status: "unread",
        limit: 50,
        autoMarkRead: false,
      });
    } catch (err) {
      this.logger.warn(
        `[Chorus] autonomous pending turn ${turnUuid}: notification re-read failed: ${err}`
      );
      return;
    }
    const notifications = result?.notifications;
    if (!Array.isArray(notifications)) {
      this.logger.warn(
        `[Chorus] autonomous pending turn ${turnUuid}: no notifications array to rebuild prompt from`
      );
      return;
    }

    // Candidate wake notifications: unread, wake-action, mapping to THIS turn's trigger.
    // ACTION_TO_TURN_TRIGGER mirrors the server's action→trigger collapse, so e.g. a
    // task_assigned turn matches task_reopened/task_verified/idea_claimed/proposal_* origins.
    const candidates = notifications.filter(
      (x) => x && typeof x.uuid === "string" && ACTION_TO_TURN_TRIGGER[x.action] === trigger
    );

    // Match the wake notification for THIS turn by its session ANCHOR. The anchor is the
    // turn's direct idea (idea-anchored session) or, lacking one, its session id; a CROSS-CWD
    // mention keys the per-instance session `${directIdeaUuid}::${connectionUuid}` with
    // directIdeaUuid=null, so the idea prefix before "::" is also a valid anchor. We never run
    // lineage on the daemon — these are the anchors the server itself keyed the session on.
    const ideaPrefix =
      directIdeaUuid == null && sessionId.includes("::") ? sessionId.split("::")[0] : null;
    const anchors = new Set(
      [directIdeaUuid, sessionId, ideaPrefix].filter((a) => typeof a === "string" && a)
    );
    let match = candidates.find((x) => anchors.has(x.entityUuid));

    // MISSED-BROADCAST RECOVERY (the rare path this re-dispatch exists for): when the wake's
    // notification entity is NOT the session anchor (a lineage-anchored task_assigned, a
    // comment-on-task mention, or a cross-cwd mention whose entity is a child of the idea),
    // the anchor equality above can't match without a lineage round-trip. If there is exactly
    // ONE unread candidate for this trigger, it is unambiguously this turn's wake — recover it.
    // With 2+ candidates we cannot disambiguate safely, so we defer to the reconnect
    // notification backfill rather than risk waking the wrong one.
    if (!match && candidates.length === 1) {
      match = candidates[0];
      this.logger.info(
        `[Chorus] autonomous pending turn ${turnUuid} (${trigger}): no anchor match, recovering the ` +
          `single unread ${trigger} notification ${match.uuid} (missed-broadcast recovery)`
      );
    }
    if (!match || typeof match.uuid !== "string") {
      this.logger.info(
        `[Chorus] autonomous pending turn ${turnUuid} (${trigger}): no unambiguous unread wake ` +
          `notification for session ${sessionId} (${candidates.length} candidate(s)) — skipping ` +
          `(covered by reconnect notification backfill)`
      );
      return;
    }

    // Cross-route dedup: claim the broadcast's key. If the broadcast already woke it (target
    // === me path), it is already seen → drop this delivery (exactly one wake). Otherwise we
    // claim it so a later broadcast copy is dropped by `dispatch`'s seen check.
    if (this.seen.has(match.uuid)) {
      this.logger.info(
        `[Chorus] autonomous pending turn ${turnUuid}: broadcast copy ${match.uuid} already handled — deduped`
      );
      return;
    }
    this.seen.add(match.uuid);

    // Rebuild + enqueue through the SAME resolve→markQueued→enqueue path as a live broadcast
    // wake, so the prompt (buildPrompt inside waker.wake), session anchor, and serialization
    // are byte-identical to the broadcast route. `match` is a full NotificationDetail.
    this.logger.info(
      `[Chorus] autonomous pending turn ${turnUuid} (${trigger}): waking from re-read notification ${match.uuid}`
    );
    await this.#resolveAndEnqueue(match, match.uuid);
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

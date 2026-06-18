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

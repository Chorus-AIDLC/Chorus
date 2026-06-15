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
   *   waker: { keyFor: (n: any) => Promise<string>, wake: (n: any, key: string) => Promise<void> },
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

    // Resolve the serialization key, then enqueue. keyFor may hit the network
    // (lineage), so do it before enqueue; the wake itself runs on the queue.
    let key;
    try {
      key = await this.waker.keyFor(n);
    } catch (err) {
      this.logger.warn(`[Chorus] could not resolve wake key for ${notificationUuid}: ${err}`);
      return;
    }
    this.queue.enqueue(key, () => this.waker.wake(n, key));
  }
}

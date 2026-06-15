// cli/backfill.mjs
// Reconnect backfill: after the SSE stream reconnects, pull notifications that
// arrived during the gap and hand each to the dispatch callback, so a dispatch
// that occurred while the daemon was briefly disconnected is not lost
// (cli-daemon spec "Reconnect with backfill"). Ported from the OpenClaw
// plugin's onReconnect logic.

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

/**
 * Build an onReconnect handler that fetches unread notifications via MCP and
 * re-emits each as a synthetic `new_notification` event into `dispatch`.
 * De-dupes against notifications already seen this run so a reconnect storm
 * doesn't double-wake.
 *
 * @param {{
 *   mcpClient: { callTool: (name: string, args?: Record<string, unknown>) => Promise<unknown> },
 *   dispatch: (event: { type: string, notificationUuid: string }) => void,
 *   seen?: Set<string>,
 *   logger?: { info(m:string):void, warn(m:string):void, error(m:string):void },
 *   limit?: number,
 * }} opts
 * @returns {() => Promise<void>}
 */
export function createBackfill(opts) {
  const { mcpClient, dispatch } = opts;
  const seen = opts.seen ?? new Set();
  const logger = opts.logger ?? NOOP_LOGGER;
  const limit = opts.limit ?? 50;

  return async function backfill() {
    let result;
    try {
      result = /** @type {{ notifications?: Array<{ uuid: string }> }} */ (
        await mcpClient.callTool("chorus_get_notifications", {
          status: "unread",
          limit,
          autoMarkRead: false,
        })
      );
    } catch (err) {
      logger.warn(`[Chorus] backfill fetch failed: ${err}`);
      return;
    }

    const notifications = result?.notifications;
    if (!Array.isArray(notifications)) {
      logger.warn("[Chorus] backfill: no notifications array in response");
      return;
    }

    let redispatched = 0;
    for (const n of notifications) {
      if (!n || typeof n.uuid !== "string") continue;
      // Pre-check only — do NOT mark seen here. The router (dispatch) is the
      // single owner of marking-at-dispatch; if backfill marked first, the
      // router's own `seen.has(...)` early-return would fire and the wake would
      // never enqueue (every backfilled dispatch silently dropped). This
      // pre-check is just a cheap early-out for notifications already handled.
      if (seen.has(n.uuid)) continue;
      redispatched++;
      dispatch({ type: "new_notification", notificationUuid: n.uuid });
    }
    if (redispatched > 0) {
      logger.info(`[Chorus] backfill re-dispatched ${redispatched} missed notification(s)`);
    }
  };
}

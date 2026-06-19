// cli/backfill.mjs
// Reconnect backfill: after the SSE stream reconnects, recover anything that
// arrived during the gap so a dispatch made while the daemon was briefly
// disconnected is not lost (cli-daemon spec "Reconnect with backfill"). Two
// sources, both re-driven through the SAME router/queue + shared `seen` set:
//
//   1. NOTIFICATIONS — pull unread notifications via MCP and re-emit each as a
//      synthetic `new_notification` event (the original OpenClaw onReconnect logic).
//      This recovers autonomous wakes (task_assigned / mentioned / elaboration / …),
//      whose actionable payload lives on the re-fetchable notification.
//
//   2. PENDING TURNS — re-derive UNSTARTED (status `pending`) DaemonSessionTurns for
//      this connection's origin-pinned sessions from the TURN TABLE (子1 —
//      daemon-session-conversation), NOT from notifications. The turn is persisted at
//      the notification chokepoint before/at notification creation, so it survives a
//      lost delivery ping; a `human_instruction`'s free-text body lives ONLY on the
//      turn, making the turn table its sole reliable backfill source. Read via
//      `GET /api/daemon/pending-turns?connectionUuid=…` (Bearer agent key, global
//      fetch — zero new deps), each re-dispatched through `router.dispatchPendingTurn`.
//
// De-dupes against the shared `seen` set so a reconnect storm doesn't double-wake.

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

/**
 * Build an onReconnect handler that (1) re-emits missed unread notifications into
 * `dispatch`, and (2) — when a connectionUuid + pending-turn dispatcher are wired —
 * re-derives this connection's unstarted (pending) turns from the turn table and
 * re-dispatches each. Both paths share the `seen` set so already-handled work is not
 * re-run.
 *
 * @param {{
 *   mcpClient: { callTool: (name: string, args?: Record<string, unknown>) => Promise<unknown> },
 *   dispatch: (event: { type: string, notificationUuid: string }) => void,
 *   seen?: Set<string>,
 *   logger?: { info(m:string):void, warn(m:string):void, error(m:string):void },
 *   limit?: number,
 *   // 子1 — pending-turn backfill (all optional; when absent, only the notification
 *   // backfill runs, preserving the original behavior/wiring):
 *   url?: string,                              Chorus base URL (for the pending-turns read).
 *   apiKey?: string,                           `cho_` agent API key.
 *   getConnectionUuid?: () => (string|null),   The daemon's registered connection uuid
 *                                              (learned from the SSE handshake). Null until
 *                                              then — the pending-turns read is skipped while null.
 *   dispatchPendingTurn?: (turn: { turnUuid: string, sessionId: string, directIdeaUuid: string|null, trigger: string, promptText: string|null }) => void,
 *   fetchImpl?: typeof fetch,                  Injectable for tests.
 * }} opts
 * @returns {() => Promise<void>}
 */
export function createBackfill(opts) {
  const { mcpClient, dispatch } = opts;
  const seen = opts.seen ?? new Set();
  const logger = opts.logger ?? NOOP_LOGGER;
  const limit = opts.limit ?? 50;
  // 子1 pending-turn backfill wiring (optional).
  const url = opts.url ? opts.url.replace(/\/$/, "") : null;
  const apiKey = opts.apiKey ?? null;
  const getConnectionUuid = opts.getConnectionUuid ?? null;
  const dispatchPendingTurn = opts.dispatchPendingTurn ?? null;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  /** Re-emit unread notifications missed during the gap (autonomous wakes). */
  async function backfillNotifications() {
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
  }

  /**
   * Re-derive this connection's UNSTARTED (pending) turns from the turn table (子1)
   * and re-dispatch each through the router. No-op (silently skipped) when the
   * pending-turn wiring is absent or the connectionUuid is not known yet. Never throws
   * into the reconnect path — a failure is logged and swallowed.
   */
  async function backfillPendingTurns() {
    if (!url || !apiKey || !getConnectionUuid || !dispatchPendingTurn) {
      // Pending-turn backfill not wired (e.g. notification-only callers / older tests).
      return;
    }
    const connectionUuid = getConnectionUuid();
    if (!connectionUuid) {
      // No connectionUuid yet (SSE handshake hasn't reported it): nothing to read
      // against. Not an error — a normal early state on the very first connect.
      return;
    }

    const endpoint = `${url}/api/daemon/pending-turns?connectionUuid=${encodeURIComponent(connectionUuid)}`;
    let response;
    try {
      response = await fetchImpl(endpoint, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      });
    } catch (err) {
      logger.warn(`[Chorus] pending-turns backfill request failed: ${err}`);
      return;
    }
    if (!response.ok) {
      logger.warn(`[Chorus] pending-turns backfill returned ${response.status}`);
      return;
    }
    let body;
    try {
      body = await response.json();
    } catch (err) {
      logger.warn(`[Chorus] pending-turns backfill: bad JSON: ${err}`);
      return;
    }
    // API envelope: { success: true, data: { turns: [...] } }.
    const data = body && typeof body === "object" ? body.data : undefined;
    const turns = data && typeof data === "object" ? data.turns : undefined;
    if (!Array.isArray(turns)) {
      logger.warn("[Chorus] pending-turns backfill: no turns array in response");
      return;
    }

    let redispatched = 0;
    for (const t of turns) {
      if (!t || typeof t.turnUuid !== "string") continue;
      // The router (dispatchPendingTurn) is the single owner of marking-seen (keyed
      // `turn:<uuid>`), exactly like the notification path — so do NOT mark here.
      if (seen.has(`turn:${t.turnUuid}`)) continue;
      redispatched++;
      dispatchPendingTurn(t);
    }
    if (redispatched > 0) {
      logger.info(`[Chorus] backfill re-derived ${redispatched} pending turn(s) from the turn table`);
    }
  }

  return async function backfill() {
    // Run both sources. Each swallows its own errors so one failing source never
    // aborts the other (a notification-fetch failure must not lose pending turns, and
    // vice versa).
    await backfillNotifications();
    await backfillPendingTurns();
  };
}

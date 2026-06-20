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
// The pending-turns READ goes through the SHARED daemon REST client
// (`cli/daemon-rest-client.mjs`), which owns the `GET /api/daemon/pending-turns` request,
// Bearer auth, the connectionUuid guard, and the no-silent-errors handling (network error
// / non-2xx / bad JSON / missing turns array are all logged with cause and surfaced).
// This module keeps only the backfill-domain concerns: the notification source, the
// `onlyTurnUuid` precision filter, the `seen` dedup, and re-dispatch.
//
// De-dupes against the shared `seen` set so a reconnect storm doesn't double-wake.
//
// The returned `backfill` function also exposes `backfill.pendingTurnsOnly` — the
// connection-scoped pending-turns sweep ALONE — so the LIVE `deliver_turn` control ping
// (子2 — origin-only live delivery) can reuse the EXACT same sweep without re-running the
// notification source. Live ping and reconnect backfill therefore converge on one sweep +
// one `seen` set, so a turn runs at most once regardless of which path observes it first.

import { createDaemonRestClient } from "./daemon-rest-client.mjs";

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
  const url = opts.url ?? null;
  const apiKey = opts.apiKey ?? null;
  const getConnectionUuid = opts.getConnectionUuid ?? null;
  const dispatchPendingTurn = opts.dispatchPendingTurn ?? null;
  // The pending-turns READ is delegated to the shared client. Built only when the
  // pending-turn backfill is wired (url + apiKey + getConnectionUuid present); otherwise
  // backfillPendingTurns is an early no-op (notification-only callers / older tests).
  const pendingTurnsClient =
    url && apiKey && getConnectionUuid
      ? createDaemonRestClient({ url, apiKey, getConnectionUuid, fetchImpl: opts.fetchImpl, logger })
      : null;

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
   * and re-dispatch them through the router. No-op (silently skipped) when the
   * pending-turn wiring is absent or the connectionUuid is not known yet. Never throws
   * into the reconnect path — a failure is logged and swallowed.
   *
   * `onlyTurnUuid` (子2 — origin-only live delivery): when set, dispatch ONLY the turn
   * with that uuid out of the fetched set, so a live `deliver_turn` ping runs PRECISELY
   * the turn it announced and never drags the connection's other still-pending turns
   * along. When omitted (the reconnect path), dispatch ALL pending turns — the lost-ping
   * safety net that recovers everything missed during a gap.
   *
   * @param {string} [onlyTurnUuid]
   */
  async function backfillPendingTurns(onlyTurnUuid) {
    if (!pendingTurnsClient || !dispatchPendingTurn) {
      // Pending-turn backfill not wired (e.g. notification-only callers / older tests).
      return;
    }
    // The shared client reads `GET /api/daemon/pending-turns?connectionUuid=…`, skipping
    // (no log) while the connectionUuid is not known yet — a normal early state — and
    // surfacing a network error / non-2xx / bad JSON / missing turns array with its cause
    // (logged) as `result.ok === false`. We just consume the parsed turns; never throw.
    const result = await pendingTurnsClient.readPendingTurns();
    if (!result.ok || !result.data) {
      // Either nothing to read yet (skipped) or a logged failure — nothing to dispatch.
      return;
    }
    const turns = result.data.turns;

    let redispatched = 0;
    for (const t of turns) {
      if (!t || typeof t.turnUuid !== "string") continue;
      // Live `deliver_turn` precision: when a specific turnUuid was announced, dispatch
      // ONLY it — skip every other pending turn of the connection (they are recovered by
      // the arg-less reconnect sweep, not by a single-turn live ping).
      if (onlyTurnUuid && t.turnUuid !== onlyTurnUuid) continue;
      // The router (dispatchPendingTurn) is the single owner of marking-seen (keyed
      // `turn:<uuid>`), exactly like the notification path — so do NOT mark here.
      if (seen.has(`turn:${t.turnUuid}`)) continue;
      redispatched++;
      dispatchPendingTurn(t);
    }
    if (redispatched > 0) {
      const scope = onlyTurnUuid ? `turn ${onlyTurnUuid}` : `${redispatched} pending turn(s)`;
      logger.info(`[Chorus] backfill re-derived ${scope} from the turn table`);
    }
  }

  async function backfill() {
    // Run both sources. Each swallows its own errors so one failing source never
    // aborts the other (a notification-fetch failure must not lose pending turns, and
    // vice versa).
    await backfillNotifications();
    await backfillPendingTurns();
  }

  // Expose the CONNECTION-SCOPED pending-turns sweep on its own so the LIVE
  // `deliver_turn` control ping (子2 — origin-only live delivery) reuses the EXACT same
  // sweep the reconnect path runs — no second sweep, no second code path. The control
  // handler triggers `backfill.pendingTurnsOnly()`; it shares the same `seen` set +
  // `dispatchPendingTurn`, so a turn delivered live and also re-derived on reconnect runs
  // at most once. Non-throwing (the inner sweep swallows + logs its own errors). The live
  // `deliver_turn` ping passes the precise `turnUuid` so ONLY that turn runs; an arg-less
  // call (reconnect) sweeps all pending.
  /** @type {(onlyTurnUuid?: string) => Promise<void>} */
  backfill.pendingTurnsOnly = backfillPendingTurns;
  return backfill;
}

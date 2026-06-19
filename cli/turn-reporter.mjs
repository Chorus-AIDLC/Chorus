// cli/turn-reporter.mjs
// Reports a wake's DaemonSessionTurn lifecycle transitions back to the Chorus server
// (子1 — daemon-session-conversation). Every wake the daemon runs is one turn on a
// persistent conversation; the server creates that turn (status `pending`) at the
// notification chokepoint, and the daemon advances it:
//   • on spawn      → pending → running
//   • on subprocess exit → running → ended
//
// The daemon does NOT know the server-side turn uuid. It identifies the turn the SAME
// way the transcript ingest does — by the session BUSINESS KEY (`sessionId` = the
// dispatched entity's directIdeaUuid, or its own uuid for an ad-hoc session: exactly
// the deterministic Claude session anchor the waker already computes). The server
// resolves the agent's `(agentUuid, sessionId)` session and advances its most-recent
// turn. The optional `entityType`/`entityUuid` let the server stamp the weak
// executionUuid link from the live execution row.
//
// Transport: a plain REST POST to `/api/daemon/turn-advance` with the daemon's existing
// Bearer agent key — the SAME zero-dep pattern as cli/interrupt-reporter.mjs and
// cli/upload-hooks.mjs (global fetch, Node 18+). It adds NO new npm dependency
// (CLAUDE.md pitfall #9) and no shell-out. It is fire-and-forget and NEVER throws into
// the wake path: a failure is LOGGED (memory: no-silent-errors) and swallowed.

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

/** Turn lifecycle states the server's turn-advance endpoint accepts. */
export const TURN_STATUSES = new Set(["pending", "running", "ended"]);

/**
 * Build an `advanceTurn(params)` function the waker invokes on a wake's spawn (→
 * running) and exit (→ ended). Returns a Promise that always resolves (never rejects)
 * so it can never crash the wake path.
 *
 * @param {{
 *   url: string,                          Chorus base URL.
 *   apiKey: string,                       `cho_` agent API key.
 *   getConnectionUuid: () => string|null, The daemon's registered connection uuid
 *                                         (learned from the SSE handshake). Required —
 *                                         a null/absent value skips the report (logged).
 *   logger?: { info(m:string):void, warn(m:string):void, error(m:string):void },
 *   fetchImpl?: typeof fetch,             Injectable for tests.
 * }} opts
 * @returns {(params: { sessionId: string, status: "running"|"ended", entityType?: string|null, entityUuid?: string|null }) => Promise<void>}
 */
export function createTurnReporter(opts) {
  const url = opts.url.replace(/\/$/, "");
  const apiKey = opts.apiKey;
  const getConnectionUuid = opts.getConnectionUuid ?? (() => null);
  const logger = opts.logger ?? NOOP_LOGGER;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  return async function advanceTurn({ sessionId, status, entityType, entityUuid }) {
    if (typeof sessionId !== "string" || !sessionId || !TURN_STATUSES.has(status)) {
      logger.warn(
        `[Chorus] refusing to advance turn: bad sessionId/status (${sessionId}, ${status})`,
      );
      return;
    }
    const connectionUuid = getConnectionUuid();
    if (!connectionUuid) {
      // The server resolves the turn against a connection the agent owns; without our
      // registered connection uuid there is nothing to address. Skip (logged) — this
      // can only happen before the SSE handshake completed.
      logger.warn(
        `[Chorus] cannot advance turn for session ${sessionId} → ${status} — no connection uuid yet`,
      );
      return;
    }

    const body = {
      connectionUuid,
      sessionId,
      status,
      // entityType/entityUuid are optional — only sent when the wake has a recognized
      // execution entity, so the server can resolve the weak executionUuid link.
      ...(entityType && entityUuid ? { entityType, entityUuid } : {}),
    };

    let response;
    try {
      response = await fetchImpl(`${url}/api/daemon/turn-advance`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      logger.warn(`[Chorus] turn-advance request failed for session ${sessionId} → ${status}: ${err}`);
      return;
    }
    if (!response.ok) {
      logger.warn(
        `[Chorus] turn-advance returned ${response.status} for session ${sessionId} → ${status}`,
      );
      return;
    }
    logger.info(`[Chorus] advanced turn for session ${sessionId} → ${status}`);
  };
}

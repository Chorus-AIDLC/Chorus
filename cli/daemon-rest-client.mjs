// cli/daemon-rest-client.mjs
// Shared, host-agnostic pure-REST client for the Chorus daemon → server reporting
// surface (`/api/daemon/*`). It is the SINGLE SOURCE OF TRUTH for the payload shapes
// the existing server endpoints accept, so the two daemon hosts — the chorus CLI daemon
// (`cli/daemon.mjs`) and the OpenClaw plugin — cannot drift in the wire contract.
//
// The five operations and their EXACT server payload shapes (verified against
// src/app/api/daemon/*/route.ts — the server is NOT changed by this work):
//   turnAdvance      → POST /api/daemon/turn-advance
//                      { connectionUuid, sessionId, status, entityType?, entityUuid? }
//   transcript       → POST /api/daemon/transcript
//                      { sessionId, messages: [{ role, text }] }
//   executionState   → POST /api/daemon/execution-state
//                      { connectionUuid, executions: [{ entityType, entityUuid,
//                                                       rootIdeaUuid|null, status,
//                                                       startedAt|null }] }
//   reportInterrupt  → POST /api/daemon/report-interrupt
//                      { connectionUuid, entityType, entityUuid, reason }
//   readPendingTurns → GET  /api/daemon/pending-turns?connectionUuid=…
//                      → { turns: [{ turnUuid, sessionId, directIdeaUuid, trigger,
//                                    promptText }] }
//
// HARD CONSTRAINTS (this module is consumed verbatim by the OpenClaw plugin too):
//   • ZERO daemon-host coupling — no child_process, no `claude` spawn, no stream-json
//     parsing, no OpenClaw SDK import. Its only outbound effect is HTTP via the
//     injected `fetchImpl` (global fetch on Node 18+). Adds NO new npm dependency
//     (CLAUDE.md pitfall #9).
//   • Bearer-only auth: every request carries `Authorization: Bearer <apiKey>`.
//   • NO SILENT ERRORS (project policy): a network error, a non-2xx response, or an
//     empty/bad body where a result is expected is LOGGED WITH ITS CAUSE and SURFACED to
//     the caller via a structured result object — never swallowed into a silent success.
//   • A failed report MUST NOT crash the run: every method RESOLVES (never rejects) with
//     a `{ ok: false, ... }` result so a fire-and-forget caller can `await` it safely.
//     The callers decide whether to react; the failure is already visible in the log.

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

/**
 * @typedef {Object} DaemonRestResult
 * @property {boolean} ok           True only on a 2xx response (and, for reads, a
 *                                  well-formed body). False on network error, non-2xx,
 *                                  or a malformed/empty body.
 * @property {number|null} status   HTTP status when a response was received; null on a
 *                                  pre-flight skip or a network-level error.
 * @property {string} [error]       Human-readable failure cause (also logged). Absent on
 *                                  success.
 * @property {boolean} [skipped]    True when the call was intentionally not issued (e.g.
 *                                  an empty transcript batch); not an error.
 * @property {*} [data]             Parsed response payload for read operations
 *                                  (`readPendingTurns` → `{ turns: [...] }`).
 */

/**
 * Build the shared daemon REST client. The inputs are entirely host-agnostic, which is
 * exactly why the same module serves both daemon hosts.
 *
 * @param {{
 *   url: string,                          Chorus base URL (a trailing slash is normalized
 *                                         away so callers may pass either form).
 *   apiKey: string,                       `cho_` agent API key for Bearer auth.
 *   getConnectionUuid?: () => (string|null), The daemon's registered connection uuid,
 *                                         learned from the SSE handshake. Read LAZILY on
 *                                         every call so construction order does not matter.
 *                                         The connection-scoped operations (turnAdvance,
 *                                         executionState, reportInterrupt, readPendingTurns)
 *                                         require it; a null value skips the call (logged).
 *   fetchImpl?: typeof fetch,             Injectable for tests (defaults to global fetch).
 *   logger?: { info(m:string):void, warn(m:string):void, error(m:string):void },
 * }} opts
 * @returns {{
 *   turnAdvance: (p: { sessionId: string, status: string, entityType?: string|null, entityUuid?: string|null }) => Promise<DaemonRestResult>,
 *   transcript: (p: { sessionId: string, messages: Array<{ role: string, text: string }> }) => Promise<DaemonRestResult>,
 *   executionState: (p: { executions: Array<Record<string, unknown>> }) => Promise<DaemonRestResult>,
 *   reportInterrupt: (p: { entityType: string, entityUuid: string, reason: string }) => Promise<DaemonRestResult>,
 *   readPendingTurns: () => Promise<DaemonRestResult>,
 * }}
 */
export function createDaemonRestClient(opts) {
  const url = opts.url.replace(/\/$/, "");
  const apiKey = opts.apiKey;
  const getConnectionUuid = opts.getConnectionUuid ?? (() => null);
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const logger = opts.logger ?? NOOP_LOGGER;

  const jsonHeaders = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  /**
   * Issue one daemon report. Owns the transport + the no-silent-errors contract that is
   * IDENTICAL across all four POST endpoints; only the `op` label (used in the log line)
   * and the path differ. Never throws — returns a structured {@link DaemonRestResult}.
   *
   * @param {string} op      Operation label for the log line (matches each endpoint's
   *                         established wording, e.g. "turn-advance",
   *                         "execution-state upload", "transcript upload",
   *                         "report-interrupt").
   * @param {string} path    Endpoint path, e.g. "/api/daemon/turn-advance".
   * @param {unknown} body   JSON-serializable request body.
   * @param {string} [successLog]  Optional info line on success.
   * @param {string} [context]     Optional " for <entity>"-style suffix appended AFTER the
   *                         `<op> request failed` / `<op> returned <status>` core, so the
   *                         failing entity stays visible in the log without disturbing the
   *                         established op-prefixed message.
   * @returns {Promise<DaemonRestResult>}
   */
  async function post(op, path, body, successLog, context = "") {
    let response;
    try {
      response = await fetchImpl(`${url}${path}`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Network-level failure (DNS, connection refused, abort, …). Surface WITH cause.
      const error = `${op} request failed${context}: ${err}`;
      logger.warn(`[Chorus] ${error}`);
      return { ok: false, status: null, error };
    }
    if (!response.ok) {
      // Non-2xx. Surface WITH the status so a 4xx/5xx is debuggable.
      const error = `${op} returned ${response.status}${context}`;
      logger.warn(`[Chorus] ${error}`);
      return { ok: false, status: response.status, error };
    }
    if (successLog) logger.info(`[Chorus] ${successLog}`);
    return { ok: true, status: response.status };
  }

  return {
    /**
     * POST /api/daemon/turn-advance — advance a wake's DaemonSessionTurn lifecycle. The
     * server resolves the turn by the session BUSINESS KEY (`sessionId`); the optional
     * `entityType`/`entityUuid` stamp the weak executionUuid link. Requires the
     * connectionUuid (the server addresses the turn against a connection the agent owns).
     */
    async turnAdvance({ sessionId, status, entityType, entityUuid }) {
      const connectionUuid = getConnectionUuid();
      if (!connectionUuid) {
        const error = `cannot advance turn for session ${sessionId} → ${status} — no connection uuid yet`;
        logger.warn(`[Chorus] ${error}`);
        return { ok: false, status: null, error, skipped: true };
      }
      const body = {
        connectionUuid,
        sessionId,
        status,
        // Only sent when BOTH are present, so the server never gets a partial linkage.
        ...(entityType && entityUuid ? { entityType, entityUuid } : {}),
      };
      return post(
        "turn-advance",
        "/api/daemon/turn-advance",
        body,
        `advanced turn for session ${sessionId} → ${status}`,
      );
    },

    /**
     * POST /api/daemon/transcript — append finalized user/assistant text to the current
     * turn, targeted by the session BUSINESS KEY (`sessionId`). The caller is responsible
     * for the content filter (only `{ role, text }` for user/assistant) and any batching.
     * No connectionUuid needed (the agent key + sessionId resolve the turn server-side).
     */
    async transcript({ sessionId, messages }) {
      return post(
        "transcript upload",
        "/api/daemon/transcript",
        { sessionId, messages },
        `transcript uploaded (${messages.length} msg) for session ${sessionId}`,
      );
    },

    /**
     * POST /api/daemon/execution-state — publish the connection's running/queued
     * execution snapshot. The caller supplies the already-built `executions` array (in
     * the server's `{ entityType, entityUuid, rootIdeaUuid|null, status, startedAt|null }`
     * shape). Requires the connectionUuid to attribute the snapshot.
     */
    async executionState({ executions }) {
      const connectionUuid = getConnectionUuid();
      if (!connectionUuid) {
        // No connectionUuid yet (SSE handshake hasn't reported it): nothing to attribute
        // the snapshot to. A normal early/edge state — surfaced as a skip, NOT an error.
        return { ok: false, status: null, skipped: true };
      }
      return post(
        "execution-state upload",
        "/api/daemon/execution-state",
        { connectionUuid, executions },
        `execution-state uploaded (${executions.length} active)`,
      );
    },

    /**
     * POST /api/daemon/report-interrupt — record a wake's `interrupted` outcome
     * (reason = "user" | "crash") on the server execution row keyed by connection +
     * entity. Requires the connectionUuid to target the right execution row.
     */
    async reportInterrupt({ entityType, entityUuid, reason }) {
      const connectionUuid = getConnectionUuid();
      if (!connectionUuid) {
        const error = `cannot report interrupt for ${entityType}:${entityUuid} — no connection uuid yet`;
        logger.warn(`[Chorus] ${error}`);
        return { ok: false, status: null, error, skipped: true };
      }
      return post(
        "report-interrupt",
        "/api/daemon/report-interrupt",
        { connectionUuid, entityType, entityUuid, reason },
        `reported ${entityType}:${entityUuid} interrupted (reason=${reason})`,
        // Keep the failing entity visible in the failure log (restores the suffix the
        // standalone interrupt reporter used to emit) without altering the asserted
        // `report-interrupt request failed` / `report-interrupt returned <status>` prefix.
        ` for ${entityType}:${entityUuid}`,
      );
    },

    /**
     * GET /api/daemon/pending-turns?connectionUuid=… — read this connection's unstarted
     * (pending) turns from the turn table (the reconnect-backfill / deliver_turn source).
     * Returns the parsed `{ turns: [...] }` data on success; a network error, a non-2xx,
     * a bad JSON body, or a missing `turns` array is LOGGED with cause and surfaced as a
     * failure result — never a silent empty success.
     *
     * @returns {Promise<DaemonRestResult & { data?: { turns: Array<{ turnUuid: string, sessionId: string, directIdeaUuid: string|null, trigger: string, promptText: string|null }> } }>}
     */
    async readPendingTurns() {
      const connectionUuid = getConnectionUuid();
      if (!connectionUuid) {
        // No connectionUuid yet: nothing to read against. A normal early state — skip.
        return { ok: false, status: null, skipped: true };
      }
      const endpoint = `${url}/api/daemon/pending-turns?connectionUuid=${encodeURIComponent(connectionUuid)}`;
      let response;
      try {
        response = await fetchImpl(endpoint, {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        });
      } catch (err) {
        const error = `pending-turns backfill request failed: ${err}`;
        logger.warn(`[Chorus] ${error}`);
        return { ok: false, status: null, error };
      }
      if (!response.ok) {
        const error = `pending-turns backfill returned ${response.status}`;
        logger.warn(`[Chorus] ${error}`);
        return { ok: false, status: response.status, error };
      }
      let parsed;
      try {
        parsed = await response.json();
      } catch (err) {
        const error = `pending-turns backfill: bad JSON: ${err}`;
        logger.warn(`[Chorus] ${error}`);
        return { ok: false, status: response.status, error };
      }
      // API envelope: { success: true, data: { turns: [...] } }.
      const data = parsed && typeof parsed === "object" ? parsed.data : undefined;
      const turns = data && typeof data === "object" ? data.turns : undefined;
      if (!Array.isArray(turns)) {
        const error = "pending-turns backfill: no turns array in response";
        logger.warn(`[Chorus] ${error}`);
        return { ok: false, status: response.status, error };
      }
      return { ok: true, status: response.status, data: { turns } };
    },
  };
}

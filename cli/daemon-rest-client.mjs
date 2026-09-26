// cli/daemon-rest-client.mjs
// Shared, host-agnostic pure-REST client for the Chorus daemon → server reporting
// surface (`/api/daemon/*`). It is the SINGLE SOURCE OF TRUTH for the payload shapes
// the existing server endpoints accept, so the two daemon hosts — the chorus CLI daemon
// (`cli/daemon.mjs`) and the OpenClaw plugin — cannot drift in the wire contract.
//
// The operations and payload fields this client supports (verified against
// src/app/api/daemon/*/route.ts):
//   turnAdvance      → POST /api/daemon/turn-advance
//                      { connectionUuid, sessionId, status, turnUuid?,
//                        backendSessionId?, entityType?, entityUuid?,
//                        interruptedReason?, transcriptRelayError?, usage?,
//                        coalescedCount? }
//   transcript       → POST /api/daemon/transcript
//                      { sessionId, messages: [{ role, text }] }
//   executionState   → POST /api/daemon/execution-state
//                      { connectionUuid, executions: [{ entityType, entityUuid,
//                                                       rootIdeaUuid|null, status,
//                                                       startedAt|null }] }
//   reportInterrupt  → POST /api/daemon/report-interrupt
//                      { connectionUuid, entityType, entityUuid, reason }
//   heartbeat        → POST /api/daemon/connection-heartbeat
//                      { connectionUuid, connectedAt }
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

// Bounded retry policy for the TERMINAL turn-advance edge only (fix-phantom-running-turn).
// A lost terminal report is the one failure that leaves a permanently phantom `running`
// turn, so it — and only it — is worth retrying. Fixed constants on purpose: one more
// configuration knob buys nothing here.
const TERMINAL_TURN_ADVANCE_ATTEMPTS = 3;
const TERMINAL_TURN_ADVANCE_DELAYS_MS = [500, 2000];

/** Real-time delay; tests inject their own so they never sleep for real. */
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A failure is retryable when repeating it can plausibly succeed: a network-level failure
 * (no HTTP response at all), a `429`, or any `5xx`. Every `4xx` is a server VERDICT
 * (invalid_transition, not_found, auth) — repeating it cannot make it true.
 * @param {number|null} status
 */
function isRetryableFailure(status) {
  return status === null || status === 429 || status >= 500;
}

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
 *   sleep?: (ms: number) => Promise<void>, Injectable retry delay (defaults to setTimeout).
 *                                         Only the terminal turn-advance edge retries.
 *   logger?: { info(m:string):void, warn(m:string):void, error(m:string):void },
 * }} opts
 * @returns {{
 *   turnAdvance: (p: { sessionId: string, turnUuid?: string|null, backendSessionId?: string|null, status: string, entityType?: string|null, entityUuid?: string|null, coalescedCount?: number }) => Promise<DaemonRestResult>,
 *   transcript: (p: { sessionId: string, messages: Array<{ role: string, text: string }> }) => Promise<DaemonRestResult>,
 *   executionState: (p: { executions: Array<Record<string, unknown>> }) => Promise<DaemonRestResult>,
 *   reportInterrupt: (p: { entityType: string, entityUuid: string, reason: string }) => Promise<DaemonRestResult>,
 *   heartbeat: (p: { connectionUuid: string, connectedAt: string }) => Promise<DaemonRestResult>,
 *   reportDirectoryRequest: (p: { requestUuid: string, status: "succeeded"|"failed", roots?: string[], items?: Array<{name:string,path:string}>, nextCursor?: string|null, normalizedPath?: string, errorCode?: string }) => Promise<DaemonRestResult>,
 *   readPendingTurns: () => Promise<DaemonRestResult>,
 * }}
 */
export function createDaemonRestClient(opts) {
  const url = opts.url.replace(/\/$/, "");
  const apiKey = opts.apiKey;
  const getConnectionUuid = opts.getConnectionUuid ?? (() => null);
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const logger = opts.logger ?? NOOP_LOGGER;
  // Injectable retry delay so tests assert the schedule without spending real seconds.
  const sleepImpl = opts.sleep ?? realSleep;

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
   * @param {boolean} [readData]   Parse the response envelope's `data` on success.
   * @param {{ attempts: number, delaysMs: number[], sleep?: (ms: number) => Promise<void> }|null} [retry]
   *                         Optional bounded retry policy. Absent/null = today's exact
   *                         single-shot behaviour (used by every op but the terminal
   *                         turn-advance edge).
   * @returns {Promise<DaemonRestResult>}
   */
  async function post(op, path, body, successLog, context = "", readData = false, retry = null) {
    const attempts = retry ? retry.attempts : 1;
    const delaysMs = retry?.delaysMs ?? [];
    // Named distinctly from the module-closure `sleepImpl` so this local never reads as a
    // shadow: callers with a retry policy pass their own sleep explicitly.
    const retrySleep = retry?.sleep ?? realSleep;

    let failure;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      failure = undefined;
      let response;
      try {
        response = await fetchImpl(`${url}${path}`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify(body),
        });
      } catch (err) {
        // Network-level failure (DNS, connection refused, abort, …). Surface WITH cause.
        // `head`/`tail` are split so the attempt ordinal can be injected before the cause.
        failure = { status: null, head: `${op} request failed${context}`, tail: `: ${err}` };
      }
      if (!failure && !response.ok) {
        // Non-2xx. Surface WITH the status so a 4xx/5xx is debuggable.
        failure = { status: response.status, head: `${op} returned ${response.status}${context}`, tail: "" };
      }
      if (!failure) {
        let data;
        if (readData) {
          try {
            const parsed = await response.json();
            data = parsed && typeof parsed === "object" ? parsed.data : undefined;
          } catch (err) {
            // Mixed-version fallback: older servers may return an empty successful body.
            // Keep the lifecycle report successful, but make the missing correlation visible.
            logger.warn(`[Chorus] ${op} response correlation unavailable: ${err}`);
          }
        }
        if (successLog) logger.info(`[Chorus] ${successLog}`);
        return { ok: true, status: response.status, ...(data !== undefined ? { data } : {}) };
      }

      const canRetry = attempt < attempts && isRetryableFailure(failure.status);
      // Per-attempt visibility, but ONLY when another attempt actually follows: the ordinal
      // exists to explain a retry. A single-shot op, or a terminal failure that will be
      // re-logged verbatim two lines below, must not emit a redundant ordinal line.
      if (canRetry) {
        logger.warn(`[Chorus] ${failure.head} (attempt ${attempt}/${attempts})${failure.tail}`);
      }
      if (!canRetry) break;
      await retrySleep(delaysMs[attempt - 1] ?? delaysMs[delaysMs.length - 1] ?? 0);
    }

    // Final failure: the message and the structured result are EXACTLY what they were
    // before retries existed, so existing log-grep expectations still match.
    const error = `${failure.head}${failure.tail}`;
    logger.warn(`[Chorus] ${error}`);
    return { ok: false, status: failure.status, error };
  }

  return {
    /**
     * POST /api/daemon/turn-advance — advance a wake's DaemonSessionTurn lifecycle. The
     * server resolves the turn by the session BUSINESS KEY (`sessionId`); the optional
     * `entityType`/`entityUuid` stamp the weak executionUuid link. An `interrupted`
     * status may carry `interruptedReason` (`user`/`crash`/`shutdown` — the server
     * rejects `offline`, which is its own reconcile verdict). A terminal edge may also
     * carry `transcriptRelayError` — the daemon-known reason its transcript upload
     * finally failed (fix #444 follow-up), persisted as a turn annotation — and `usage`,
     * the whole normalized per-turn TokenUsage object (daemon-token-usage), persisted as
     * the turn's usage. Both ride the terminal edge only. Requires the connectionUuid (the
     * server addresses the turn against a connection the agent owns).
     */
    async turnAdvance({ sessionId, turnUuid, status, entityType, entityUuid, interruptedReason, transcriptRelayError, usage, backendSessionId, coalescedCount }) {
      const connectionUuid = getConnectionUuid();
      if (!connectionUuid) {
        const error = `cannot advance turn for session ${sessionId} → ${status} — no connection uuid yet`;
        logger.warn(`[Chorus] ${error}`);
        return { ok: false, status: null, error, skipped: true };
      }
      // Per-turn token usage (daemon-token-usage) is meaningful only on a TERMINAL edge —
      // the daemon knows it at subprocess exit, exactly like transcriptRelayError. Guard on
      // the terminal status here so a stray usage on → running is never sent (the server
      // ignores it there anyway; this keeps the wire honest).
      const isTerminal = status === "ended" || status === "interrupted";
      const body = {
        connectionUuid,
        sessionId,
        status,
        ...(turnUuid ? { turnUuid } : {}),
        // Only sent when BOTH are present, so the server never gets a partial linkage.
        ...(entityType && entityUuid ? { entityType, entityUuid } : {}),
        // Only meaningful alongside status=interrupted; never sent otherwise.
        ...(status === "interrupted" && interruptedReason ? { interruptedReason } : {}),
        // Transcript-relay failure annotation (fix #444 follow-up): only sent when the
        // daemon actually knows the upload failed (a truthy reason on a terminal edge).
        ...(transcriptRelayError ? { transcriptRelayError } : {}),
        // The whole normalized TokenUsage object, nested under `usage`, only on a terminal edge.
        ...(usage && isTerminal ? { usage } : {}),
        ...(backendSessionId && isTerminal ? { backendSessionId } : {}),
        // Coalesced-wake count (add-daemon-wake-coalescing): meaningful ONLY on the → running
        // edge, where the server settles the next (count − 1) same-session pending turns to
        // `merged`. Sent only when a real batch coalesced (> 1); a single wake (default 1)
        // omits it so the wire — and every existing turn-advance test — stays byte-identical.
        ...(status === "running" && typeof coalescedCount === "number" && coalescedCount > 1
          ? { coalescedCount }
          : {}),
      };
      const result = await post(
        "turn-advance",
        "/api/daemon/turn-advance",
        body,
        `advanced turn for session ${sessionId} → ${status}`,
        "",
        status === "running",
        // Bounded retry on the TERMINAL edge only. A lost `→ ended`/`→ interrupted` report
        // is what strands a turn as phantom `running` forever; the `→ running` edge is not
        // retried because the wake is about to run anyway and a stale retry could race the
        // terminal edge. The repeat is safe: the daemon sends the `turnUuid` it learned
        // from its own → running report, and advanceTurnForWake returns the existing
        // projection for a same-turn same-terminal-status replay (no second usage rollup,
        // timestamp write or SSE publish). Without a turnUuid, the FIFO lookup finds no
        // `running` turn and answers not_found, changing nothing.
        isTerminal
          ? {
              attempts: TERMINAL_TURN_ADVANCE_ATTEMPTS,
              delaysMs: TERMINAL_TURN_ADVANCE_DELAYS_MS,
              sleep: sleepImpl,
            }
          : null,
      );
      const resolvedTurnUuid =
        typeof result.data?.turn?.uuid === "string" ? result.data.turn.uuid : null;
      if (status !== "running") return result;
      const { data: _rawData, ...baseResult } = result;
      return resolvedTurnUuid
        ? { ...baseResult, data: { turnUuid: resolvedTurnUuid } }
        : baseResult;
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
     * POST /api/daemon/connection-heartbeat — acknowledge receipt of one SSE heartbeat.
     * The values come directly from the active stream's registration handshake; unlike
     * other connection-scoped operations this must not resolve the uuid lazily, because
     * a delayed acknowledgment must retain its original generation fence.
     */
    async heartbeat({ connectionUuid, connectedAt }) {
      return post(
        "connection-heartbeat",
        "/api/daemon/connection-heartbeat",
        { connectionUuid, connectedAt },
      );
    },

    async reportDirectoryRequest({ requestUuid, status, roots, items, nextCursor, normalizedPath, errorCode }) {
      const connectionUuid = getConnectionUuid();
      if (!connectionUuid) {
        const error = `cannot report directory request ${requestUuid} — no connection uuid yet`;
        logger.warn(`[Chorus] ${error}`);
        return { ok: false, status: null, error, skipped: true };
      }
      const body = { requestUuid, connectionUuid, status };
      if (status === "succeeded") {
        if (roots !== undefined) body.roots = roots;
        if (items !== undefined) body.items = items;
        if (nextCursor !== undefined) body.nextCursor = nextCursor;
        if (normalizedPath !== undefined) body.normalizedPath = normalizedPath;
      } else {
        body.errorCode = errorCode ?? "INTERNAL_ERROR";
      }
      return post(
        "directory-request report",
        "/api/daemon/directory-request/report",
        body,
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
      // Opt in only with exact Research admission + isolated queue support. The
      // server withholds Research from older clients that cannot acknowledge it.
      const endpoint = `${url}/api/daemon/pending-turns?connectionUuid=${encodeURIComponent(connectionUuid)}&researchProtocol=1`;
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

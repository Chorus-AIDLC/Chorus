// cli/turn-reporter.mjs
// Reports a wake's DaemonSessionTurn lifecycle transitions back to the Chorus server
// (子1 — daemon-session-conversation). Every wake the daemon runs is one turn on a
// persistent conversation; the server creates that turn (status `pending`) at the
// notification chokepoint, and the daemon advances it:
//   • on spawn      → pending → running
//   • on subprocess exit → running → ended (clean) | interrupted (user/crash/shutdown)
//
// The daemon does NOT know the server-side turn uuid. It identifies the turn the SAME
// way the transcript ingest does — by the session BUSINESS KEY (`sessionId` = the
// dispatched entity's directIdeaUuid, or its own uuid for an ad-hoc session: exactly
// the deterministic Claude session anchor the waker already computes). The server
// resolves the agent's `(agentUuid, sessionId)` session and advances its most-recent
// turn. The optional `entityType`/`entityUuid` let the server stamp the weak
// executionUuid link from the live execution row.
//
// Transport: the SHARED daemon REST client (`cli/daemon-rest-client.mjs`) owns the actual
// `POST /api/daemon/turn-advance` request, its Bearer auth, and the no-silent-errors
// transport contract — this module is the thin domain wrapper that validates the
// status/sessionId and maps the wake's call into the client's `turnAdvance` payload. It
// adds NO new npm dependency (CLAUDE.md pitfall #9) and no shell-out. It is
// fire-and-forget and NEVER throws into the wake path: a failure is LOGGED by the shared
// client (memory: no-silent-errors) and the returned result is swallowed.

import { createDaemonRestClient } from "./daemon-rest-client.mjs";

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

/** Turn lifecycle states the server's turn-advance endpoint accepts. */
export const TURN_STATUSES = new Set(["pending", "running", "ended", "interrupted"]);

/** Interrupt reasons a DAEMON may report (`offline` is server-reconcile-only). */
export const TURN_INTERRUPT_REASONS = new Set(["user", "crash", "shutdown"]);

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
 * @returns {(params: { sessionId: string, status: "running"|"ended"|"interrupted", entityType?: string|null, entityUuid?: string|null, interruptedReason?: "user"|"crash"|"shutdown"|null, transcriptRelayError?: string|null }) => Promise<void>}
 */
export function createTurnReporter(opts) {
  const logger = opts.logger ?? NOOP_LOGGER;
  // The shared client owns the request, Bearer auth, the connectionUuid guard, and the
  // surface-not-swallow transport contract. This wrapper keeps only the turn-domain
  // validation (status / sessionId) that is NOT the client's concern.
  const client = createDaemonRestClient({
    url: opts.url,
    apiKey: opts.apiKey,
    getConnectionUuid: opts.getConnectionUuid ?? (() => null),
    fetchImpl: opts.fetchImpl,
    logger,
  });

  return async function advanceTurn({
    sessionId,
    status,
    entityType,
    entityUuid,
    interruptedReason,
    transcriptRelayError,
  }) {
    if (typeof sessionId !== "string" || !sessionId || !TURN_STATUSES.has(status)) {
      logger.warn(
        `[Chorus] refusing to advance turn: bad sessionId/status (${sessionId}, ${status})`,
      );
      return;
    }
    // Domain guard mirroring the server's: a reason travels only with `interrupted`
    // and only from the daemon-reportable vocabulary (`offline` is the server's own
    // reconcile verdict). Refusing here keeps a bad caller visible in daemon logs
    // instead of as a server 400.
    if (interruptedReason != null) {
      if (status !== "interrupted" || !TURN_INTERRUPT_REASONS.has(interruptedReason)) {
        logger.warn(
          `[Chorus] refusing to advance turn: bad interruptedReason (${interruptedReason}) for status ${status}`,
        );
        return;
      }
    }
    // The client resolves the connectionUuid lazily, validates it (logging
    // "no connection uuid yet" when absent), POSTs the exact server payload — sending
    // entityType/entityUuid only when both are present, and transcriptRelayError only when
    // truthy (fix #444 follow-up) — and logs the failure cause on a network error / non-2xx.
    // We swallow the structured result so a failed report can never crash the wake path.
    await client.turnAdvance({
      sessionId,
      status,
      entityType,
      entityUuid,
      interruptedReason,
      transcriptRelayError,
    });
  };
}

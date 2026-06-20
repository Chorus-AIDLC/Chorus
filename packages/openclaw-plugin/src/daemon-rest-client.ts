// packages/openclaw-plugin/src/daemon-rest-client.ts
// TypeScript mirror of the shared, host-agnostic pure-REST client for the Chorus
// daemon → server reporting surface (`/api/daemon/*`).
//
// WHY A MIRROR (not an import): the single-source-of-truth implementation is
// `cli/daemon-rest-client.mjs`, consumed verbatim by the chorus CLI daemon. The
// OpenClaw plugin, however, is a SEPARATELY-PUBLISHED npm package
// (`@chorus-aidlc/chorus-openclaw-plugin`, `files: ["src", "dist", ...]`) whose
// TS build has `rootDir: "src"`. Importing a file under `cli/` (outside both the
// package boundary AND rootDir) is rejected by `tsc` and would not be present in
// the published tarball. So we mirror the EXACT same factory + payload shapes here
// — this is NOT a fork of the wire contract: every payload below is byte-for-byte
// the shape `cli/daemon-rest-client.mjs` sends (and the server already accepts).
// The two files are kept in lock-step by the spec's "single source of truth for
// the payload shapes" requirement; a drift would be caught by T5 (live e2e).
//
// The five operations and their EXACT server payload shapes (verified against
// cli/daemon-rest-client.mjs + src/app/api/daemon/*/route.ts — server unchanged):
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
// HARD CONSTRAINTS (identical to the CLI client):
//   • ZERO daemon-host coupling — no child_process, no OpenClaw SDK import. Its only
//     outbound effect is HTTP via the injected `fetchImpl` (global fetch on Node 18+).
//     Adds NO new npm dependency (CLAUDE.md pitfall #9).
//   • Bearer-only auth: every request carries `Authorization: Bearer <apiKey>`.
//   • NO SILENT ERRORS (project policy): a network error, a non-2xx response, or a
//     bad/empty body is LOGGED WITH ITS CAUSE and SURFACED via a structured result —
//     never swallowed into a silent success.
//   • A failed report NEVER rejects: every method RESOLVES with `{ ok: false, ... }`
//     so a fire-and-forget caller can `await` it safely.

export interface DaemonRestLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

const NOOP_LOGGER: DaemonRestLogger = { info() {}, warn() {}, error() {} };

/** A single transcript message — only `role` + visible `text` (no internals). */
export interface DaemonTranscriptMessage {
  role: "user" | "assistant";
  text: string;
}

/** One execution-snapshot row, in the server's exact `execution-state` shape. */
export interface DaemonExecutionRow {
  entityType: string;
  entityUuid: string;
  rootIdeaUuid: string | null;
  status: "running" | "queued";
  startedAt: string | null;
}

/** One unstarted (pending) turn read back from the turn table. */
export interface DaemonPendingTurn {
  turnUuid: string;
  sessionId: string;
  directIdeaUuid: string | null;
  trigger: string;
  promptText: string | null;
}

/**
 * Structured result of every client call. Mirrors the CLI client's
 * `DaemonRestResult`: `ok` is true only on a 2xx (and, for reads, a well-formed
 * body); `error` carries the (also-logged) failure cause; `skipped` marks an
 * intentional non-call (e.g. no connection uuid yet); `data` holds parsed read
 * payloads.
 */
export interface DaemonRestResult<TData = unknown> {
  ok: boolean;
  status: number | null;
  error?: string;
  skipped?: boolean;
  data?: TData;
}

export interface CreateDaemonRestClientOptions {
  /** Chorus base URL (a trailing slash is normalized away). */
  url: string;
  /** `cho_` agent API key for Bearer auth. */
  apiKey: string;
  /**
   * The daemon's registered connection uuid (learned from the SSE handshake),
   * read LAZILY on every call so construction order does not matter. The
   * connection-scoped operations (turnAdvance, executionState, reportInterrupt,
   * readPendingTurns) require it; a null value skips the call (logged where the
   * skip is unexpected, silent where it is a normal early state).
   */
  getConnectionUuid?: () => string | null;
  /** Injectable for tests (defaults to global fetch). */
  fetchImpl?: typeof fetch;
  logger?: DaemonRestLogger;
}

export interface DaemonRestClient {
  turnAdvance(p: {
    sessionId: string;
    status: "running" | "ended";
    entityType?: string | null;
    entityUuid?: string | null;
  }): Promise<DaemonRestResult>;
  transcript(p: {
    sessionId: string;
    messages: DaemonTranscriptMessage[];
  }): Promise<DaemonRestResult>;
  executionState(p: { executions: DaemonExecutionRow[] }): Promise<DaemonRestResult>;
  reportInterrupt(p: {
    entityType: string;
    entityUuid: string;
    reason: "user" | "crash";
  }): Promise<DaemonRestResult>;
  readPendingTurns(): Promise<DaemonRestResult<{ turns: DaemonPendingTurn[] }>>;
}

/**
 * Build the shared daemon REST client. Inputs are entirely host-agnostic, which is
 * exactly why the same surface serves both daemon hosts.
 */
export function createDaemonRestClient(opts: CreateDaemonRestClientOptions): DaemonRestClient {
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
   * Issue one daemon report. Owns the transport + the no-silent-errors contract
   * IDENTICAL across all four POST endpoints; only the `op` label and the path
   * differ. Never throws — returns a structured {@link DaemonRestResult}.
   */
  async function post(
    op: string,
    path: string,
    body: unknown,
    successLog?: string,
    context = "",
  ): Promise<DaemonRestResult> {
    let response: Response;
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
     * POST /api/daemon/turn-advance — advance a wake's DaemonSessionTurn lifecycle.
     * The server resolves the turn by the session BUSINESS KEY (`sessionId`); the
     * optional `entityType`/`entityUuid` stamp the weak executionUuid link. Requires
     * the connectionUuid.
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
     * POST /api/daemon/transcript — append finalized user/assistant text to the
     * current turn, targeted by the session BUSINESS KEY. The caller owns the content
     * filter (only `{ role, text }`) and any batching. No connectionUuid needed.
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
     * execution snapshot (caller supplies the already-built `executions` array).
     * Requires the connectionUuid; a null uuid is a normal early state (silent skip).
     */
    async executionState({ executions }) {
      const connectionUuid = getConnectionUuid();
      if (!connectionUuid) {
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
     * (reason = "user" | "crash") on the execution row keyed by connection + entity.
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
        ` for ${entityType}:${entityUuid}`,
      );
    },

    /**
     * GET /api/daemon/pending-turns?connectionUuid=… — read this connection's
     * unstarted (pending) turns. Returns the parsed `{ turns: [...] }` data on
     * success; a network error / non-2xx / bad body / missing array is logged with
     * cause and surfaced as a failure result — never a silent empty success.
     */
    async readPendingTurns() {
      const connectionUuid = getConnectionUuid();
      if (!connectionUuid) {
        return { ok: false, status: null, skipped: true };
      }
      const endpoint = `${url}/api/daemon/pending-turns?connectionUuid=${encodeURIComponent(connectionUuid)}`;
      let response: Response;
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
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (err) {
        const error = `pending-turns backfill: bad JSON: ${err}`;
        logger.warn(`[Chorus] ${error}`);
        return { ok: false, status: response.status, error };
      }
      // API envelope: { success: true, data: { turns: [...] } }.
      const data =
        parsed && typeof parsed === "object"
          ? (parsed as { data?: unknown }).data
          : undefined;
      const turns =
        data && typeof data === "object" ? (data as { turns?: unknown }).turns : undefined;
      if (!Array.isArray(turns)) {
        const error = "pending-turns backfill: no turns array in response";
        logger.warn(`[Chorus] ${error}`);
        return { ok: false, status: response.status, error };
      }
      return { ok: true, status: response.status, data: { turns: turns as DaemonPendingTurn[] } };
    },
  };
}

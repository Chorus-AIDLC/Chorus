// cli/upload-hooks.mjs
// Execution-state upload hook for the daemon's observability layer
// (daemon-execution-state spec, design.md "Implementation Plan" step 3).
//
// The daemon already knows, in process memory, which tasks it is running and
// which are queued (the WakeQueue's scheduling state, joined with the waker's
// per-task lineage map). This module turns that into the snapshot the server's
// ingest endpoint expects and POSTs it:
//
//   POST /api/daemon/execution-state
//   { connectionUuid, executions: [{ taskUuid, rootIdeaUuid|null, status, startedAt|null }] }
//
// Reuses global fetch (Node 18+) and the daemon's existing Bearer credentials —
// exactly like lineage.mjs / sse-listener.mjs — so it adds ZERO new dependency
// (CLAUDE.md pitfall #9), no shell-out, no platform-specific paths. The POST is
// fire-and-forget: it never blocks or breaks the wake path, and a failed upload
// is LOGGED (no silent errors) and non-fatal — it never throws to the caller.
//
// `status` is constrained to "running"/"queued"; "ended" is a server-only
// terminal state the daemon never reports (the server rejects it).

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

/**
 * @typedef {Object} SnapshotExecution
 * @property {string} taskUuid
 * @property {string|null} [rootIdeaUuid]   null for a task with no root-idea lineage.
 * @property {"running"|"queued"} status
 * @property {string|null} [startedAt]      ISO-8601; null while merely queued.
 */

/**
 * @typedef {Object} UploadHooks
 * @property {(info: { host: string, agentUuid?: string }) => Promise<void>} onConnect
 * @property {(info: { rootIdeaKey: string, sessionId: string, isNew: boolean }) => Promise<void>} onSessionStart
 * @property {(info: { rootIdeaKey: string, sessionId: string, message: any }) => Promise<void>} onTranscriptMessage
 * @property {() => void} [onExecutionChange]  Fire-and-forget: upload a fresh
 *   execution snapshot. The waker calls this on every lifecycle transition
 *   (enqueue / wake start / wake finish). No-op in the noop hooks.
 */

/**
 * The default no-op hooks. Each resolves immediately and does nothing — no
 * network, no disk. Used in tests and as a safe default where execution upload
 * is not wired (e.g. the daemon could not learn its connectionUuid).
 * @returns {UploadHooks}
 */
export function createNoopUploadHooks() {
  return {
    async onConnect() {},
    async onSessionStart() {},
    async onTranscriptMessage() {},
    onExecutionChange() {},
  };
}

/**
 * Build the execution-state upload hooks. The returned `onExecutionChange()` is
 * synchronous and non-throwing: it kicks off a fire-and-forget POST and returns
 * immediately, so the wake path is never blocked. The transcript/session/connect
 * hooks remain no-ops (reserved for a later observability slice).
 *
 * @param {{
 *   url: string,                         Chorus base URL.
 *   apiKey: string,                      `cho_` agent API key.
 *   getConnectionUuid: () => (string|null),  The connection this daemon registered
 *                                            as (null until the SSE handshake
 *                                            reports it — uploads are skipped while null).
 *   getSnapshot: () => SnapshotExecution[],  Builds the current snapshot from live
 *                                            daemon state (WakeQueue + waker lineage map).
 *   logger?: { info(m:string):void, warn(m:string):void, error(m:string):void },
 *   fetchImpl?: typeof fetch,            Injectable for tests.
 * }} opts
 * @returns {UploadHooks}
 */
export function createExecutionUploadHooks(opts) {
  const url = opts.url.replace(/\/$/, "");
  const apiKey = opts.apiKey;
  const getConnectionUuid = opts.getConnectionUuid;
  const getSnapshot = opts.getSnapshot;
  const logger = opts.logger ?? NOOP_LOGGER;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  // Serialize uploads so two rapid transitions can't reorder on the wire (a
  // later snapshot must not land before an earlier one). The snapshot is
  // captured SYNCHRONOUSLY at emit time (not re-read at send time): each
  // lifecycle transition's state is preserved even when transitions happen
  // faster than uploads flush — so a brief "running" state is never silently
  // collapsed into the subsequent "finished" upload.
  let chain = Promise.resolve();

  /** POST a captured snapshot. Never throws. */
  async function upload(executions) {
    const connectionUuid = getConnectionUuid();
    if (!connectionUuid) {
      // No connectionUuid yet (SSE handshake hasn't reported it): nothing to
      // attribute the snapshot to. Not an error — a normal early/edge state.
      return;
    }
    const body = JSON.stringify({ connectionUuid, executions });

    let response;
    try {
      response = await fetchImpl(`${url}/api/daemon/execution-state`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body,
      });
    } catch (err) {
      logger.warn(`[Chorus] execution-state upload request failed: ${err}`);
      return;
    }
    if (!response.ok) {
      logger.warn(`[Chorus] execution-state upload returned ${response.status}`);
      return;
    }
    logger.info(`[Chorus] execution-state uploaded (${executions.length} active)`);
  }

  return {
    async onConnect() {},
    async onSessionStart() {},
    async onTranscriptMessage() {},
    /**
     * Fire-and-forget upload of the current snapshot. Synchronous + non-throwing
     * so it never blocks/breaks the wake path. The snapshot is captured here, at
     * call time, then queued behind any in-flight upload; failures are logged
     * inside `upload()`. A snapshot-build error is logged and skips the POST.
     */
    onExecutionChange() {
      let executions;
      try {
        executions = getSnapshot();
      } catch (err) {
        logger.warn(`[Chorus] execution snapshot build failed: ${err}`);
        return;
      }
      // Chain on both fulfill and reject so one failed upload can't wedge the
      // chain; `upload` already swallows its own errors, this is belt-and-braces.
      const run = () => upload(executions);
      chain = chain.then(run, run);
    },
  };
}

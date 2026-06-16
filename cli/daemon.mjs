// cli/daemon.mjs
// `chorus daemon` — the assembled client daemon. Wires together:
//   CredentialResolver → ChorusClient (MCP) + SseListener (+ reconnect backfill)
//     → EventRouter → WakeQueue → Waker (LineageResolver + SessionMap + ClaudeSpawner)
// On a task_assigned (and other wake actions) it spawns a local headless Claude
// Code, serialized per root idea, that acts via the chorus_* MCP tools.
//
// Connection / session / transcript reporting to the server is intentionally
// NOT done here — the no-op UploadHooks reserve those seams for the derived
// observability idea.

import { resolveCredentials } from "./credentials.mjs";
import { ChorusClient, validateAndFetchIdentity } from "./chorus-client.mjs";
import { SseListener } from "./sse-listener.mjs";
import { createBackfill } from "./backfill.mjs";
import { EventRouter } from "./event-router.mjs";
import { WakeQueue } from "./wake-queue.mjs";
import { Waker } from "./waker.mjs";
import { LineageResolver } from "./lineage.mjs";
import { SessionMap } from "./session-map.mjs";
import { ClaudeSpawner, resolveClaudePath } from "./claude-spawner.mjs";
import { createExecutionUploadHooks } from "./upload-hooks.mjs";
import { WAKE_ACTIONS } from "./prompts.mjs";

function defaultLogger() {
  return {
    info: (m) => process.stdout.write(`${m}\n`),
    warn: (m) => process.stderr.write(`${m}\n`),
    error: (m) => process.stderr.write(`${m}\n`),
  };
}

/**
 * Build the fully-wired daemon without starting it. Returned object exposes
 * `start()` / `stop()` and the internal pieces (for integration tests).
 *
 * @param {{ url: string, apiKey: string }} creds
 * @param {{
 *   logger?: any,
 *   mcpClient?: any,
 *   lineage?: any,
 *   fetchImpl?: typeof fetch,
 *   sseListener?: any,
 *   spawner?: any,
 *   sessionMap?: any,
 *   hooks?: any,
 *   makeSseListener?: (opts: any) => any,
 *   maxConcurrency?: number,
 *   permissionMode?: "chorus"|"yolo",
 * }} [deps]
 */
export function buildDaemon(creds, deps = {}) {
  const logger = deps.logger ?? defaultLogger();
  const permissionMode = deps.permissionMode ?? "chorus";

  const mcpClient =
    deps.mcpClient ?? new ChorusClient({ url: creds.url, apiKey: creds.apiKey, logger });
  // Lineage resolution is a plain REST call (Bearer agent key) per notification —
  // it does not go through the MCP client. (deps.fetchImpl is injectable for tests.)
  const lineage =
    deps.lineage ??
    new LineageResolver({ url: creds.url, apiKey: creds.apiKey, logger, fetchImpl: deps.fetchImpl });
  const sessionMap = deps.sessionMap ?? new SessionMap({ logger });
  const spawner = deps.spawner ?? new ClaudeSpawner({ logger, permissionMode });
  const queue = new WakeQueue({ maxConcurrency: deps.maxConcurrency ?? 4, logger });

  // The connection this daemon registered as. Learned from the SSE handshake's
  // `connection_registered` event (threaded via the listener's onConnectionId).
  // Held in a mutable box so the upload hooks (created before the listener) can
  // read the latest value after the handshake. `waker` is assigned just below;
  // the snapshot closure reads it lazily so the hooks can predate it.
  /** @type {{ connectionUuid: string|null }} */
  const connectionState = { connectionUuid: null };
  /** @type {Waker|undefined} */
  let waker;

  // Execution-state upload hooks: POST the WakeQueue/waker-derived snapshot to
  // the server on each lifecycle transition. `getSnapshot` reads the waker's
  // per-task registry (which reuses the already-resolved root-idea lineage).
  // Fire-and-forget; failures logged + non-fatal (see upload-hooks.mjs). The
  // hooks share the daemon's existing creds + zero new deps (global fetch).
  const hooks =
    deps.hooks ??
    createExecutionUploadHooks({
      url: creds.url,
      apiKey: creds.apiKey,
      getConnectionUuid: () => connectionState.connectionUuid,
      getSnapshot: () => waker?.buildExecutionSnapshot() ?? [],
      logger,
      fetchImpl: deps.fetchImpl,
    });

  // One dedup set shared by the router (live SSE path) and the reconnect
  // backfill, so a notification handled live is never re-woken on reconnect.
  const seen = new Set();
  waker = new Waker({ creds, lineage, sessionMap, spawner, hooks, logger });
  const router = new EventRouter({ mcpClient, waker, queue, wakeActions: WAKE_ACTIONS, seen, logger });

  // Reconnect backfill re-dispatches notifications missed during a gap, through
  // the SAME router/queue (so serialization holds) and the SAME seen set (so
  // already-handled notifications are skipped). The router marks seen at
  // dispatch; backfill's own pre-check is a cheap early-out.
  const backfill = createBackfill({
    mcpClient,
    dispatch: (event) => router.dispatch(event),
    seen,
    logger,
  });

  const sseListener =
    deps.sseListener ??
    (deps.makeSseListener ?? ((o) => new SseListener(o)))({
      url: creds.url,
      apiKey: creds.apiKey,
      onEvent: (event) => router.dispatch(event),
      // Capture the connectionUuid the server reports for this stream so the
      // execution-state upload hooks can attribute snapshots to it.
      onConnectionId: (connectionUuid) => {
        connectionState.connectionUuid = connectionUuid;
        logger.info(`[Chorus] registered as connection ${connectionUuid}`);
      },
      onReconnect: backfill,
      logger,
    });

  return {
    mcpClient,
    lineage,
    sessionMap,
    spawner,
    queue,
    waker,
    router,
    sseListener,
    async start() {
      await hooks.onConnect?.({ host: creds.url });
      await sseListener.connect();
    },
    async stop() {
      sseListener.disconnect?.();
      await mcpClient.disconnect?.();
    },
  };
}

/**
 * Entry point for `chorus daemon`. Resolves credentials, validates them
 * (echoing the agent identity), and runs the daemon until terminated.
 *
 * @param {{ url?: string, apiKey?: string, yolo?: boolean }} flags
 * @param {{
 *   resolve?: typeof resolveCredentials,
 *   validate?: typeof validateAndFetchIdentity,
 *   build?: typeof buildDaemon,
 *   log?: (m: string) => void,
 *   errLog?: (m: string) => void,
 *   waitForever?: () => Promise<void>,
 *   env?: Record<string, string|undefined>,
 * }} [deps]
 * @returns {Promise<number>}
 */
export async function runDaemon(flags = {}, deps = {}) {
  const resolve = deps.resolve ?? resolveCredentials;
  const validate = deps.validate ?? validateAndFetchIdentity;
  const build = deps.build ?? buildDaemon;
  const log = deps.log ?? ((m) => process.stdout.write(`${m}\n`));
  const errLog = deps.errLog ?? ((m) => process.stderr.write(`${m}\n`));
  const env = deps.env ?? process.env;

  // --yolo flag or CHORUS_YOLO env → full autonomy; default → chorus-only.
  const yolo = flags.yolo === true || env.CHORUS_YOLO === "1" || env.CHORUS_YOLO === "true";
  const permissionMode = yolo ? "yolo" : "chorus";

  let creds;
  try {
    creds = resolve(flags);
  } catch (err) {
    errLog(err instanceof Error ? err.message : String(err));
    return 1;
  }
  log(`[Chorus] credentials resolved from: ${creds.source}`);

  // Validate + echo identity before opening the long-lived connection.
  let identity;
  try {
    identity = await validate({ url: creds.url, apiKey: creds.apiKey });
  } catch (err) {
    errLog(`[Chorus] credential validation failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  log(`[Chorus] authenticated as ${identity.name} (${identity.uuid})`);

  // Make the permission posture loud — it determines what a woken Claude can do.
  if (permissionMode === "yolo") {
    errLog(
      "[Chorus] ⚠ PERMISSION MODE: YOLO (--dangerously-skip-permissions) — woken Claude has FULL " +
        "autonomy: Bash, file writes, any command, under this daemon's API key. Run only in a " +
        "trusted/sandboxed environment with people you trust to dispatch to it."
    );
  } else {
    log(
      "[Chorus] permission mode: chorus (default) — woken Claude may use Chorus MCP tools only " +
        "(comment/claim/report/status), NOT Bash or file edits. Pass --yolo for full autonomy."
    );
  }

  // Warn (don't fail) if claude isn't found — the daemon still subscribes; a
  // wake will surface the missing-binary error visibly when one arrives.
  if (!resolveClaudePath()) {
    errLog("[Chorus] WARNING: `claude` not found on PATH — wakes will fail until it is installed.");
  }

  const daemon = build(creds, { logger: { info: log, warn: errLog, error: errLog }, permissionMode });

  // Graceful shutdown on signals.
  const shutdown = () => {
    log("[Chorus] shutting down daemon...");
    Promise.resolve(daemon.stop()).finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log(`[Chorus] daemon starting — subscribing to ${creds.url}/api/events/notifications`);
  await daemon.start();
  log("[Chorus] daemon running. Waiting for task dispatches (Ctrl+C to stop).");

  // Keep the process alive for the long-lived SSE subscription.
  await (deps.waitForever ?? (() => new Promise(() => {})))();
  return 0;
}

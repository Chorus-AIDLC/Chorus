// cli/daemon.mjs
// `chorus daemon` — the assembled client daemon. Wires together:
//   CredentialResolver → ChorusClient (MCP) + SseListener (+ reconnect backfill)
//     → EventRouter → WakeQueue → Waker (LineageResolver + ClaudeSpawner)
// On a task_assigned (and other wake actions) it spawns a local headless Claude
// Code, serialized per DIRECT idea, that acts via the chorus_* MCP tools. The
// Claude session id is the dispatched entity's direct idea uuid (deterministic,
// so a human can `claude --resume <idea-uuid>`); new-vs-resume is decided by
// probing the on-disk transcript — there is no persisted session-id map.
//
// Wake coalescing (add-daemon-wake-coalescing): the WakeQueue is PER-CONNECTION
// and serializes per DIRECT idea (= per session). Wakes that pile up on the same
// key while a turn runs are drained together and delivered as ONE batch — a
// single runBatch → waker.wakeBatch → one `claude --resume` turn — so N
// same-session queued wakes coalesce into one turn, never N sequential turns.
//
// Connection / session / transcript reporting to the server is intentionally
// NOT done here — the no-op UploadHooks reserve those seams for the derived
// observability idea.

import { resolveCredentials, loginFilePath } from "./credentials.mjs";
import { prompt, writeLoginFile, updateDaemonConfig } from "./login.mjs";
import {
  resolveInstallCredentials,
  resolveInstallCwds,
  resolveInstallBrowseRoots,
  resolveInstallAgent,
} from "./daemon-install-config.mjs";
import {
  resolvePermissionMode,
  yoloWarningLine,
} from "./daemon-permission-mode.mjs";
import { resolveAgentType, backendClientType } from "./daemon-agent.mjs";
import { formatBanner, agentNotFoundWarningLine } from "./daemon-banner.mjs";
import { ChorusClient, validateAndFetchIdentity } from "./chorus-client.mjs";
import { SseListener } from "./sse-listener.mjs";
import { createBackfill } from "./backfill.mjs";
import { EventRouter } from "./event-router.mjs";
import { WakeQueue } from "./wake-queue.mjs";
import { Waker } from "./waker.mjs";
import { LineageResolver } from "./lineage.mjs";
import { resolveClaudePath } from "./claude-spawner.mjs";
import { resolveCodexPath } from "./codex-spawner.mjs";
import { resolveKiroPath } from "./kiro-spawner.mjs";
import { selectSpawner } from "./spawner-select.mjs";
import {
  createExecutionUploadHooks,
  createTranscriptUploadHooks,
  mergeUploadHooks,
} from "./upload-hooks.mjs";
import { WAKE_ACTIONS } from "./prompts.mjs";
import { createInterruptReporter } from "./interrupt-reporter.mjs";
import { createTurnReporter } from "./turn-reporter.mjs";
import { createDaemonRestClient } from "./daemon-rest-client.mjs";
import { createControlHandler } from "./control-handler.mjs";
import {
  resolveSigintTimeoutMs,
  resolveDaemonCwds,
  resolveBrowseRoots,
  resolveAgentConfigs,
  hasConfiguredAgents,
} from "./daemon-config.mjs";
import { discoverDirectories, validateDirectory } from "./directory-discovery.mjs";
import {
  startBackground,
  stopDaemon,
  isRunning,
  readLog,
} from "./daemon-lifecycle.mjs";
import {
  detectSupervisor,
  installService,
  uninstallService,
  systemctlUser,
  journalctlUser,
  resolveServicePaths,
  SERVICE_NAME,
} from "./daemon-service.mjs";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Env marker set on the detached child so it skips the interactive preflight. */
export const DETACHED_ENV = "CHORUS_DAEMON_DETACHED";

/** Read the chorus CLI version from package.json (best-effort; "?" on failure). */
function readVersion() {
  try {
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? "?";
  } catch {
    return "?";
  }
}

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
 *   cwd?: string,   Single served path (back-compat); maps to a one-element cwd set.
 *   cwds?: Array<string|undefined>,  The SET of paths this daemon serves (T3 多路径). Each entry registers one independent connection bound to that cwd; `undefined` ⇒ process cwd. Takes precedence over `cwd`.
 *   hooks?: any,
 *   makeSseListener?: (opts: any) => any,
 *   maxConcurrency?: number,
 *   permissionMode?: "chorus"|"yolo",
 *   reportInterrupt?: (entityType: string, entityUuid: string, reason: "user"|"crash") => Promise<void>,
 *   advanceTurn?: (params: { sessionId: string, status: "running"|"ended", entityType?: string|null, entityUuid?: string|null }) => Promise<void>,
 *   sigintTimeoutMs?: number,
 * }} [deps]
 */
export function buildDaemon(creds, deps = {}) {
  const logger = deps.logger ?? defaultLogger();
  const permissionMode = deps.permissionMode ?? "chorus";
  // The resolved agent backend selects which spawner the daemon injects
  // (add-daemon-codex-backend). Defaults to claude-code, matching the prior
  // hard-wired ClaudeSpawner. The spawn path below is backend-agnostic — it only
  // ever calls the shared wake(...) contract.
  const agentType = deps.agentType ?? "claude-code";
  // Per-wake verbose logging (daemon-startup-output), threaded into the Waker.
  const verbose = deps.verbose ?? false;
  // Escalation window for the interrupt killer (子3). Pre-resolved by runDaemon via
  // the layered resolver; falls back to the resolver's default here when not given,
  // so a daemon built directly (integration tests) still gets a sane value.
  const sigintTimeoutMs = deps.sigintTimeoutMs ?? resolveSigintTimeoutMs();
  const browseRoots = deps.browseRoots ?? resolveBrowseRoots();
  // ===== Shared deps (one set per daemon process) =====
  // These are process-wide — independent of how many paths (cwds) the daemon serves.
  const mcpClient =
    deps.mcpClient ?? new ChorusClient({ url: creds.url, apiKey: creds.apiKey, logger });
  // Lineage resolution is a plain REST call (Bearer agent key) per notification —
  // it does not go through the MCP client. (deps.fetchImpl is injectable for tests.)
  const lineage =
    deps.lineage ??
    new LineageResolver({ url: creds.url, apiKey: creds.apiKey, logger, fetchImpl: deps.fetchImpl });
  // Inject the spawner for the resolved backend. claude-code → ClaudeSpawner
  // (construction byte-identical to before); codex → CodexSpawner. `creds` are
  // passed through so the Codex backend can export the daemon key into the woken
  // process env (the Claude backend ignores creds — it gets its key via --mcp-config).
  const spawner = deps.spawner ?? selectSpawner(agentType, { logger, permissionMode, creds });
  const maxConcurrency = deps.maxConcurrency ?? 4;

  // ===== Multi-path: the SET of cwds this daemon serves (T3 — FR-5) =====
  // Each declared path becomes one INDEPENDENT connection (own SSE self-report + own
  // Waker bound to that cwd + own router/backfill/control). The daemon process's OWN
  // cwd never changes (NFR-3). `undefined` ⇒ "serve the process default cwd" (single-
  // path / HARD-1 default). `deps.cwds` (a list) takes precedence; `deps.cwd` (a single
  // value, still injected by integration tests) maps to a one-element set; otherwise a
  // single `[undefined]` connection at the process cwd — exactly today's behavior. This
  // is JUST a list of paths; it carries NO path↔project binding (DEC-5: cwd ⟂ project).
  const cwdSet =
    Array.isArray(deps.cwds) && deps.cwds.length > 0
      ? deps.cwds
      : [deps.cwd];

  // ===== All-conflict exit latch (add-daemon-connection-conflict-skip, Q3) =====
  // Each declared connection resolves to exactly one terminal outcome: REGISTERED
  // (saw connection_registered → onConnectionId) or CONFLICTED (saw
  // connection_conflict → onConflict). When EVERY declared connection has resolved
  // AND none registered (≥1 conflicted, 0 survived), the daemon has nothing to serve,
  // so we settle `allConflict` — runDaemon races this against waitForever and returns
  // a non-zero exit. The latch is evaluated only after all connections resolve (R5):
  // a path still mid-handshake leaves `resolved < total`, so a partial conflict never
  // triggers the exit. A connection that registers (even after some conflicted) flips
  // `anyRegistered`, so the exit never fires while at least one path serves.
  const totalConnections = cwdSet.length;
  let resolvedConnections = 0;
  let anyRegistered = false;
  let settleAllConflict; // resolver, wired into the promise below
  // A promise that settles ONLY in the all-paths-conflicted case. It never rejects and
  // never settles otherwise (a serving daemon simply keeps waiting on waitForever).
  const allConflict = new Promise((resolve) => {
    settleAllConflict = resolve;
  });
  // Record one connection's terminal outcome and, once all have resolved, decide whether
  // the whole daemon should exit. Idempotent per connection BY CONSTRUCTION: the guard
  // lives here (flips the connection's own `outcome.resolved`) so a reconnect's repeated
  // connection_registered — or any future caller — can never double-count, no matter the
  // call site. The first terminal signal for a connection wins; later ones are no-ops.
  function recordConnectionOutcome(outcome, registered) {
    if (outcome.resolved) return;
    outcome.resolved = true;
    resolvedConnections += 1;
    if (registered) anyRegistered = true;
    if (resolvedConnections === totalConnections && !anyRegistered) {
      settleAllConflict();
    }
  }

  /**
   * Build ONE independent path-connection bound to `cwd` (one SSE stream → one
   * DaemonConnection row, keyed by that cwd server-side). All per-connection state —
   * its connectionUuid box, reporters, hooks, Waker(cwd), router, backfill, control
   * handler, and SseListener(cwd) — lives in this closure so two connections never
   * share a connectionUuid or a dedup set. `index` selects the per-connection injected
   * test dep (sseListener/makeSseListener) when an array was supplied (a single value
   * is reused for connection 0, mirroring the historical single-connection injection).
   * @param {string|undefined} cwd
   * @param {number} index
   */
  function buildConnection(cwd, index) {
    // connectionState holds the connectionUuid learned from THIS stream's SSE handshake;
    // the reporters, hooks, and control handler read it lazily so construction order
    // doesn't matter. Per-connection so each path's wakes report against the right row.
    /** @type {{ connectionUuid: string|null }} */
    const connectionState = { connectionUuid: null };
    const daemonRestClient = createDaemonRestClient({
      url: creds.url,
      apiKey: creds.apiKey,
      getConnectionUuid: () => connectionState.connectionUuid,
      logger,
      fetchImpl: deps.fetchImpl,
    });

    // Per-connection terminal-outcome bookkeeping (add-daemon-connection-conflict-skip).
    // `resolved` guards recordConnectionOutcome against double-counting a reconnect's
    // repeated connection_registered. `skipped` marks a cwd surrendered to a live
    // different-process daemon — purely informational (the listener is torn down, so it
    // simply never reconnects), kept on the returned object for inspection/tests.
    const outcome = { resolved: false, skipped: false };

    // Interrupt reporter (子3): REST POST with the daemon's Bearer key. Injectable for
    // tests (shared across connections when injected — tests use a single connection).
    const reportInterrupt =
      deps.reportInterrupt ??
      createInterruptReporter({
        url: creds.url,
        apiKey: creds.apiKey,
        getConnectionUuid: () => connectionState.connectionUuid,
        logger,
        fetchImpl: deps.fetchImpl,
      });
    // Turn-lifecycle reporter (子1): advances the server-side DaemonSessionTurn on
    // spawn (→ running) and exit (→ ended), reading the connectionUuid lazily.
    const advanceTurn =
      deps.advanceTurn ??
      createTurnReporter({
        url: creds.url,
        apiKey: creds.apiKey,
        getConnectionUuid: () => connectionState.connectionUuid,
        logger,
        fetchImpl: deps.fetchImpl,
      });

    /** @type {Map<string, Waker>} */
    const runtimeWakers = new Map();
    let waker;

    // Execution + transcript upload hooks (子1), merged. Bound to THIS connection's
    // connectionState + waker so snapshots attribute to the right connection row.
    const hooks =
      deps.hooks ??
      mergeUploadHooks(
        createExecutionUploadHooks({
          url: creds.url,
          apiKey: creds.apiKey,
          getConnectionUuid: () => connectionState.connectionUuid,
          getSnapshot: () =>
            [...runtimeWakers.values()].flatMap((candidate) => candidate.buildExecutionSnapshot()),
          logger,
          fetchImpl: deps.fetchImpl,
        }),
        createTranscriptUploadHooks({
          url: creds.url,
          apiKey: creds.apiKey,
          logger,
          fetchImpl: deps.fetchImpl,
        }),
        { logger }
      );

    // One dedup set per connection, shared by its router (live SSE) and its reconnect
    // backfill, so a notification handled live is never re-woken on reconnect.
    const seen = new Set();
    // The Waker is bound to THIS connection's cwd: it uses cwd BOTH to probe the
    // transcript (new-vs-resume) and to spawn, so they never diverge (Module Contract
    // 1 — resolveCwd is the single source). `cwd` is `undefined` for the single-path /
    // old-daemon default, which the Waker degrades to process.cwd() (HARD-1).
    const makeWaker = (boundCwd) =>
      new Waker({
        creds,
        lineage,
        spawner,
        cwd: boundCwd,
        hooks,
        logger,
        reportInterrupt,
        advanceTurn,
        verbose,
        validateRuntimeCwd: (runtimeCwd) => validateDirectory({ cwd: runtimeCwd, browseRoots }),
        killer: deps.killer,
        sigintTimeoutMs,
      });
    const startupKey = cwd ?? process.cwd();
    runtimeWakers.set(startupKey, makeWaker(cwd));
    const selectWaker = (notification) => {
      const runtimeCwd =
        typeof notification?.runtimeCwd === "string" && notification.runtimeCwd
          ? notification.runtimeCwd
          : startupKey;
      let selected = runtimeWakers.get(runtimeCwd);
      if (!selected) {
        selected = makeWaker(runtimeCwd);
        runtimeWakers.set(runtimeCwd, selected);
      }
      return selected;
    };
    const startupWaker = runtimeWakers.get(startupKey);
    waker = {
      get executions() {
        const merged = new Map();
        for (const candidate of runtimeWakers.values()) {
          for (const [key, value] of candidate.executions) merged.set(key, value);
        }
        return merged;
      },
      get interrupting() {
        return {
          has: (key) =>
            [...runtimeWakers.values()].some((candidate) => candidate.interrupting.has(key)),
        };
      },
      keyFor: (notification) => startupWaker.keyFor(notification),
      resolveCwd: () => startupWaker.resolveCwd(),
      markQueued: (notification, key, attribution) =>
        selectWaker(notification).markQueued(notification, key, attribution),
      wake: (notification, key, attribution) =>
        selectWaker(notification).wake(notification, key, attribution),
      // Coalesced batch (add-daemon-wake-coalescing): every item shares the key → the same
      // session → the same cwd (a session's cwd is pinned), so route the whole batch to the
      // waker selected by the first item's runtimeCwd.
      wakeBatch: (notifications, key, attribution) =>
        selectWaker(notifications[0]).wakeBatch(notifications, key, attribution),
      markInterrupting(entityType, entityUuid) {
        for (const candidate of runtimeWakers.values()) {
          if (candidate.executions.has(`${entityType}:${entityUuid}`)) {
            candidate.markInterrupting(entityType, entityUuid);
          }
        }
      },
      interruptAll() {
        for (const candidate of runtimeWakers.values()) candidate.interruptAll();
      },
      buildExecutionSnapshot: () =>
        [...runtimeWakers.values()].flatMap((candidate) => candidate.buildExecutionSnapshot()),
    };
    // The WakeQueue serializes per DIRECT idea (keyFor's key) and coalesces same-key pending
    // wakes into one batch (add-daemon-wake-coalescing §C1/§C4). It is PER-CONNECTION so the
    // batch runs on THIS connection's own waker facade — the runBatch drains the per-key data
    // items { notification, attribution } and hands the whole batch to waker.wakeBatch (all
    // items on one key share the session anchor, so items[0].attribution is the batch
    // attribution). maxConcurrency caps this connection's in-flight batches.
    const queue = new WakeQueue({
      maxConcurrency,
      logger,
      runBatch: (key, items) =>
        waker.wakeBatch(items.map((i) => i.notification), key, items[0].attribution),
    });

    // The router reads THIS connection's own uuid lazily (same source the control handler
    // uses) to suppress a DIRECTED (pinned) wake stamped for a different connection
    // (fix-pinned-wake-directed-delivery, T2). Null until the SSE handshake assigns it — a
    // targeted wake arriving in that window is treated as "not mine" → suppressed (delivery
    // covered by the deliver_turn ping to the actual target + the reconnect pending backfill).
    const router = new EventRouter({
      mcpClient,
      waker,
      queue,
      wakeActions: WAKE_ACTIONS,
      seen,
      getConnectionUuid: () => connectionState.connectionUuid,
      logger,
    });

    // Reverse control channel (子3) + resume re-dispatch + origin-only deliver_turn —
    // all scoped to THIS connection's uuid/router/backfill (see the original wiring
    // comments retained on the shared helpers). The control handler verifies a control
    // event against this connection's own connectionUuid before acting.
    const redispatchResume = (entityType, entityUuid, resumeReason, runtimeCwd) => {
      router.dispatchResume?.({ entityType, entityUuid, resumeReason, runtimeCwd });
    };
    const deliverTurn = (turnUuid) => backfill?.pendingTurnsOnly?.(turnUuid);
    const onControl = createControlHandler({
      waker,
      getConnectionUuid: () => connectionState.connectionUuid,
      sigintTimeoutMs,
      redispatchResume,
      deliverTurn,
      handleDirectoryRequest: async (event) => {
        if (event.operation === "roots") {
          return { roots: [...browseRoots] };
        }
        if (event.operation === "validate") {
          return validateDirectory({ cwd: event.cwd, browseRoots });
        }
        return discoverDirectories({
          prefix: event.prefix,
          cursor: event.cursor,
          limit: event.limit,
          browseRoots,
        });
      },
      reportDirectoryRequest: (result) => daemonRestClient.reportDirectoryRequest(result),
      logger,
    });

    // Reconnect + pending-turn backfill, pinned to THIS connection's sessions (the
    // server scopes getPendingTurnsForConnection by originConnectionUuid — i.e. the
    // cwd this connection serves — so a multi-path daemon's backfill never re-runs
    // another cwd's turns).
    const backfill = createBackfill({
      mcpClient,
      dispatch: (event) => router.dispatch(event),
      seen,
      logger,
      url: creds.url,
      apiKey: creds.apiKey,
      getConnectionUuid: () => connectionState.connectionUuid,
      dispatchPendingTurn: (turn) => router.dispatchPendingTurn?.(turn),
      fetchImpl: deps.fetchImpl,
    });

    // Per-connection SSE listener, self-reporting THIS connection's cwd so the server
    // registers it as a distinct (agent, clientType, host, cwd) row. Test injection:
    //  - `deps.sseListener` is a CONCRETE instance — there is only one, so it stands in
    //    for connection 0 only (a single-path daemon, the historical injection shape).
    //  - `deps.makeSseListener` is a FACTORY — it is invoked PER connection (so a
    //    multi-path test gets one mock listener per cwd). An array form also works:
    //    one factory/instance per connection by index.
    const injectedListener = Array.isArray(deps.sseListener)
      ? deps.sseListener[index]
      : index === 0
        ? deps.sseListener
        : undefined;
    const makeSse =
      (Array.isArray(deps.makeSseListener) ? deps.makeSseListener[index] : deps.makeSseListener) ??
      ((o) => new SseListener(o));
    const sseListener =
      injectedListener ??
      makeSse({
        url: creds.url,
        apiKey: creds.apiKey,
        // Self-report the SELECTED backend so the connection registry + presence UI
        // label a codex daemon as `codex` (not the hardcoded `claude_code`).
        clientType: backendClientType(agentType),
        // The working directory THIS connection serves (T3). `undefined` ⇒ the listener
        // reports its process cwd (single-path / HARD-1). It is just the served path.
        cwd,
        onEvent: (event) => router.dispatch(event),
        onConnectionId: (connectionUuid) => {
          connectionState.connectionUuid = connectionUuid;
          logger.info(
            `[Chorus] registered as connection ${connectionUuid}` +
              (cwd ? ` (cwd=${cwd})` : "")
          );
          // Terminal outcome: this path registered. recordConnectionOutcome is idempotent
          // per connection, so a reconnect's repeated connection_registered counts once.
          recordConnectionOutcome(outcome, true);
        },
        // Connection conflict (add-daemon-connection-conflict-skip, Q3/Q4): the server
        // refused to register THIS cwd because a live different-process daemon already
        // holds the same (agent, host, cwd). Warn prominently, tear the listener down
        // (disconnect clears the reconnect timer + aborts), and mark the path skipped —
        // it is never reconnected/re-probed for the process lifetime. Takeover happens
        // only on the NEXT daemon start/restart. Independent closures mean skipping this
        // path never disturbs another connection's dispatch/control.
        onConflict: (event) => {
          const conflictCwd = (event && event.cwd) ?? cwd ?? process.cwd();
          const conflictHost = (event && event.host) || "this host";
          logger.warn(
            `[Chorus] ⚠ connection conflict: a live daemon already serves ` +
              `(host=${conflictHost}, cwd=${conflictCwd}) — skipping this path. ` +
              `Stop the other daemon (or wait for it to go offline) and restart to take it over.`
          );
          outcome.skipped = true;
          // Tear down THIS path's listener: no reconnect, no re-probe (Q4).
          sseListener.disconnect?.();
          // Terminal outcome: this path conflicted (idempotent — counts once).
          recordConnectionOutcome(outcome, false);
        },
        onControl,
        acknowledgeHeartbeat: (registration) => daemonRestClient.heartbeat(registration),
        onReconnect: backfill,
        logger,
      });

    return {
      cwd,
      connectionState,
      waker,
      runtimeWakers,
      queue,
      router,
      backfill,
      sseListener,
      hooks,
      outcome,
    };
  }

  // Build one connection per declared cwd. The order is the declaration order; the
  // FIRST connection's pieces are aliased onto the returned object for backward
  // compatibility (existing tests/inspection read daemon.waker / .router / .sseListener).
  const connections = cwdSet.map((cwd, i) => buildConnection(cwd, i));
  const primary = connections[0];

  return {
    mcpClient,
    lineage,
    spawner,
    // Back-compat single-connection aliases (the common single-path case). The full
    // set is exposed as `connections` for multi-path inspection/tests. The WakeQueue is
    // now per-connection (add-daemon-wake-coalescing) so its runBatch can run on the right
    // connection's waker facade; the primary connection's queue is aliased here.
    queue: primary.queue,
    waker: primary.waker,
    router: primary.router,
    sseListener: primary.sseListener,
    connections,
    // Settles ONLY when every declared connection resolved and none registered
    // (all paths already served by a live daemon — Q3). runDaemon races this against
    // waitForever to exit non-zero. Never settles for a serving daemon.
    allConflict,
    async start() {
      // Connect every path-connection. Each fires its own onConnect hook + SSE connect;
      // the daemon process cwd is untouched (NFR-3).
      for (const c of connections) {
        await c.hooks.onConnect?.({ host: creds.url });
        await c.sseListener.connect();
      }
    },
    async stop() {
      // Graceful shutdown ordering (fix-daemon-exit-orphan-running-turn):
      // 1. Stop taking new work: disconnect the SSE listeners (no new notifications)
      //    and latch the queue (queued-but-unstarted wakes never spawn).
      for (const c of connections) {
        c.sseListener.disconnect?.();
        // Latch each connection's OWN queue (queues are per-connection now — add-daemon-
        // wake-coalescing) so queued-but-unstarted wakes never spawn.
        c.queue?.stop?.();
      }
      // 2. Interrupt every in-flight wake subprocess via the shared kill escalation.
      //    Each wake's exit path — seeing shuttingDown — reports its turn
      //    interrupted(shutdown) and suppresses the execution crash report.
      for (const c of connections) {
        c.waker?.interruptAll?.();
      }
      // 3. Await the in-flight wakes so those turn-advance reports flush, BOUNDED:
      //    the kill escalation window plus a hard 5s cap for the exit path's REST
      //    reports. A wake that outlives this does NOT hang the shutdown — its
      //    orphaned turn is the server-side offline reconcile's job (the backstop).
      //    Drain every connection's queue in parallel; `drained` is true only if all did.
      const drainResults = await Promise.all(
        connections.map((c) => c.queue?.drain?.(sigintTimeoutMs + 5_000) ?? true),
      );
      const drained = drainResults.every(Boolean);
      if (!drained) {
        logger.warn(
          "[Chorus] shutdown: in-flight wake(s) did not finish within the bound — exiting anyway (server reconcile will finalize their turns)",
        );
      }
      // 4. The MCP client is process-wide (shared) — disconnect it once.
      await mcpClient.disconnect?.();
    },
  };
}

/**
 * Fan-out builder: compose ONE `buildDaemon` runtime per agent config, so a single
 * daemon process serves N fully-independent agents — each with its own creds,
 * ChorusClient, LineageResolver, spawner (by its `agentType`), WakeQueue (its own
 * `maxConcurrency`), and connections over its OWN cwds. For N=1 this is behaviorally
 * identical to `buildDaemon({url,apiKey}, deps)`.
 *
 * Each agent's runtime is isolated: a build/start failure in one agent is logged and
 * skipped, and the others keep serving. The aggregate `allConflict` settles only when
 * EVERY agent's paths are all already served (nothing left to do at all).
 *
 * Injectable seams mirror `buildDaemon`; array-valued deps (`spawner`, `mcpClient`,
 * `lineage`, `sseListener`, `makeSseListener`) are indexed PER agent for tests.
 *
 * @param {import("./daemon-config.mjs").AgentConfig[]} agentConfigs
 * @param {object} [deps]
 * @returns {{ agents: Array<{cfg: any, daemon: any}>, connections: any[],
 *   waker: any, router: any, sseListener: any, allConflict: Promise<void>,
 *   start: () => Promise<void>, stop: () => Promise<void> }}
 */
export function buildMultiAgentDaemon(agentConfigs, deps = {}) {
  const logger = deps.logger ?? defaultLogger();
  if (!Array.isArray(agentConfigs) || agentConfigs.length === 0) {
    throw new Error("buildMultiAgentDaemon: at least one agent config is required");
  }
  const build = deps.build ?? buildDaemon;
  const perAgent = (key, i) => {
    const v = deps[key];
    return Array.isArray(v) ? v[i] : i === 0 ? v : undefined;
  };

  const agents = agentConfigs
    .map((cfg, i) => {
      // Per-agent deps: cfg fields drive the per-agent runtime; injectable fakes are
      // indexed per agent. `cwd` (singular) is cleared so a caller's single value can
      // never leak across agents — each agent's `cwds` is authoritative.
      const agentDeps = {
        ...deps,
        logger,
        permissionMode: cfg.permissionMode,
        agentType: cfg.agentType,
        cwds: cfg.cwds,
        cwd: undefined,
        maxConcurrency: cfg.maxConcurrency,
        sigintTimeoutMs: cfg.sigintTimeoutMs,
        browseRoots: cfg.browseRoots,
        mcpClient: perAgent("mcpClient", i),
        lineage: perAgent("lineage", i),
        spawner: perAgent("spawner", i),
        sseListener: perAgent("sseListener", i),
        makeSseListener: Array.isArray(deps.makeSseListener)
          ? deps.makeSseListener[i]
          : deps.makeSseListener,
      };
      try {
        return { cfg, daemon: build({ url: cfg.url, apiKey: cfg.apiKey }, agentDeps) };
      } catch (err) {
        logger.error?.(
          `[Chorus] agent ${cfg.label}: failed to build runtime — skipping ` +
            `(${err instanceof Error ? err.message : String(err)})`,
        );
        return null;
      }
    })
    .filter(Boolean);

  if (agents.length === 0) {
    throw new Error("buildMultiAgentDaemon: all agent runtimes failed to build");
  }

  const connections = agents.flatMap((a) => a.daemon.connections ?? []);
  const primary = agents[0].daemon;
  // Aggregate all-conflict: settles only when EVERY agent's paths are all already
  // served by a live daemon (each agent's allConflict settles only in that case, and
  // never otherwise). A single serving agent keeps the whole daemon alive.
  const allConflict = Promise.all(
    agents.map((a) => a.daemon.allConflict ?? new Promise(() => {})),
  ).then(() => {});

  return {
    agents,
    connections,
    // Back-compat single aliases (first agent's primary connection) for inspection.
    waker: primary.waker,
    router: primary.router,
    sseListener: primary.sseListener,
    allConflict,
    async start() {
      // Start each agent independently; one agent's start failure is logged and
      // isolated so the others still serve.
      for (const a of agents) {
        try {
          await a.daemon.start();
        } catch (err) {
          logger.error?.(
            `[Chorus] agent ${a.cfg.label}: start failed — ` +
              `${err instanceof Error ? err.message : String(err)} (other agents continue)`,
          );
        }
      }
    },
    async stop() {
      for (const a of agents) {
        try {
          await a.daemon.stop();
        } catch (err) {
          logger.warn?.(
            `[Chorus] agent ${a.cfg.label}: stop error — ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    },
  };
}

/**
 * Entry point for `chorus daemon`. Resolves credentials, validates them
 * (echoing the agent identity), and runs the daemon until terminated.
 *
 * @param {{ url?: string, apiKey?: string, yolo?: boolean, sigintTimeout?: number|string }} flags
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
  // TTY detection + IO seams (injectable for tests). Default to the real stdin
  // TTY flag and the real prompt / ack helpers.
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);
  const askPrompt = deps.prompt ?? prompt;
  const writeCreds = deps.writeLoginFile ?? writeLoginFile;
  const version = deps.version ?? readVersion();
  // Backend executable resolvers — injectable for tests. The SELECTED backend's
  // resolver runs below (claude-code → findClaude, codex → findCodex), so the
  // banner shows the right binary instead of always probing for `claude`.
  const findClaude = deps.resolveClaudePath ?? resolveClaudePath;
  const findCodex = deps.resolveCodexPath ?? resolveCodexPath;
  const findKiro = deps.resolveKiroPath ?? resolveKiroPath;
  const verbose = flags.verbose === true || env.CHORUS_VERBOSE === "1";

  // Resolve the agent backend (default claude-code). An unknown --agent /
  // CHORUS_AGENT is a hard error — no silent fallback (daemon-agent-selection).
  const agentResult = resolveAgentType(flags, env);
  if (!agentResult.ok) {
    errLog(`[Chorus] ${agentResult.error}`);
    return 1;
  }
  const agentType = agentResult.agent;

  // Lifecycle subcommands (stop/status/restart/logs) operate on the pidfile/logfile
  // managed by the `-d` path — they never start the long-lived foreground daemon.
  // `run` falls through to the normal startup below. Injectable lifecycle for tests.
  // stopDaemon's real signature is (io, opts); the bundle exposes (opts) with the
  // default io so handleLifecycleAction can pass { force } directly.
  const lifecycle = deps.lifecycle ?? {
    startBackground,
    stopDaemon: (opts) => stopDaemon(undefined, opts),
    isRunning,
    readLog,
  };
  // Supervisor (systemd --user) seam — install/uninstall the boot service and
  // detect/delegate to it from the lifecycle subcommands. Injectable for tests
  // (no real systemctl / disk). Defaults to the real daemon-service module.
  const service = deps.service ?? {
    detectSupervisor,
    installService,
    uninstallService,
    systemctlUser,
    journalctlUser,
    resolveServicePaths: () => resolveServicePaths(env),
  };
  // The preflight dep bundle — built from the same seams runDaemon resolved, so
  // the detach/restart paths run the SAME (injectable) preflight, not the real
  // implementations. Threaded into startDetached so tests can drive it offline.
  // writeConfig / readJson / loginPath are optional injectable IO used by the
  // `install` config phase — default (undefined) means the real 0600 login file.
  const pfDeps = {
    flags, env, isTTY, resolve, validate, writeCreds, askPrompt, log, errLog,
    writeConfig: deps.writeConfig,
    readJson: deps.readJson,
    loginPath: deps.loginPath,
  };

  const action = flags.action ?? "run";
  if (action !== "run") {
    return handleLifecycleAction(action, { log, errLog, lifecycle, service, pfDeps });
  }

  // `-d` / --detach: complete any interactive preflight in THIS foreground process
  // (which holds the TTY), then spawn the daemon detached and return. The detached
  // child re-enters runDaemon with the DETACHED_ENV marker set, so it skips the
  // preflight prompts. A child run (marker present) falls through to normal startup.
  const isDetachedChild = env[DETACHED_ENV] === "1";
  if (flags.detach && !isDetachedChild) {
    return startDetached({ log, errLog, lifecycle, pfDeps });
  }

  // SIGINT-escalation window for the interrupt killer (子3) — layered:
  //   --sigint-timeout flag > CHORUS_DAEMON_SIGINT_TIMEOUT env > ~/.chorus/daemon.json > 10000.
  const sigintTimeoutMs = resolveSigintTimeoutMs({ sigintTimeout: flags.sigintTimeout }, { env });

  // The SET of working directories this daemon serves (T3 — 单 daemon 多路径引擎).
  // Layered: --cwd flag(s) > CHORUS_DAEMON_CWDS env > ~/.chorus/daemon.json `cwds`
  // > [undefined] (single connection at the process cwd). A single `[undefined]`
  // is exactly today's single-path behavior. JUST a list of paths — no project
  // binding (DEC-5: cwd ⟂ project). The daemon process's own cwd never changes.
  const cwds = resolveDaemonCwds({ cwd: flags.cwd }, { env });
  const browseRoots = resolveBrowseRoots({ browseRoot: flags.browseRoot }, { env });

  // ===== Multi-agent mode (daemon-multi-agent) =====
  // When daemon.json declares a non-empty agents[], run N fully-independent agents in
  // one process. Each agent carries its OWN creds, so this bypasses the flat single-
  // credential preflight (interactive credential completion is a single-agent
  // affordance). Each agent authenticates on its own key; a failure is isolated
  // (logged + that agent skipped) so the rest still serve.
  if (hasConfiguredAgents({ readJson: deps.readJson, loginPath: deps.loginPath })) {
    const buildMulti = deps.buildMulti ?? buildMultiAgentDaemon;
    let agentConfigs;
    try {
      agentConfigs = resolveAgentConfigs(
        {
          url: flags.url,
          apiKey: flags.apiKey,
          agent: flags.agent,
          cwd: flags.cwd,
          browseRoot: flags.browseRoot,
          sigintTimeout: flags.sigintTimeout,
          chorusOnly: flags.chorusOnly,
          yolo: flags.yolo,
        },
        { env, readJson: deps.readJson, loginPath: deps.loginPath },
      );
    } catch (err) {
      errLog(`[Chorus] ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }

    // Validate each agent independently. A validation failure logs + skips that agent
    // (isolation) — the daemon still serves the agents that authenticated.
    const okConfigs = [];
    for (const cfg of agentConfigs) {
      try {
        const id = await validate({ url: cfg.url, apiKey: cfg.apiKey });
        okConfigs.push(cfg);
        log(
          `[Chorus] agent ${cfg.label}: ${id.name} (${id.uuid}) — ${cfg.agentType}, ` +
            `${cfg.permissionMode}, ${cfg.cwds.length} path(s), maxConcurrency=${cfg.maxConcurrency}`,
        );
        if (cfg.permissionMode === "yolo") errLog(`[Chorus] agent ${cfg.label}: ${yoloWarningLine()}`);
      } catch (err) {
        errLog(
          `[Chorus] agent ${cfg.label}: credential validation failed — ` +
            `${err instanceof Error ? err.message : String(err)} (skipping this agent)`,
        );
      }
    }
    if (okConfigs.length === 0) {
      errLog(
        `[Chorus] no agents authenticated — nothing to serve. Check the apiKeys in ${loginFilePath()}.`,
      );
      return 1;
    }

    const totalPaths = okConfigs.reduce((n, c) => n + c.cwds.length, 0);
    log(
      `[Chorus] multi-agent daemon starting — ${okConfigs.length} agent(s), ` +
        `${totalPaths} connection(s), subscribing to ${okConfigs[0].url}/api/events/notifications`,
    );
    const multiDaemon = buildMulti(okConfigs, {
      logger: { info: log, warn: errLog, error: errLog },
      verbose,
      fetchImpl: deps.fetchImpl,
      killer: deps.killer,
      sseListener: deps.sseListener,
      makeSseListener: deps.makeSseListener,
      spawner: deps.spawner,
      mcpClient: deps.mcpClient,
      lineage: deps.lineage,
      build: deps.build,
    });

    const shutdownMulti = () => {
      log("[Chorus] shutting down daemon...");
      Promise.resolve(multiDaemon.stop()).finally(() => process.exit(0));
    };
    process.on("SIGINT", shutdownMulti);
    process.on("SIGTERM", shutdownMulti);
    await multiDaemon.start();
    log("[Chorus] multi-agent daemon running. Waiting for task dispatches (Ctrl+C to stop).");

    const ALL_CONFLICT_M = Symbol("all-conflict");
    const waitForeverM = deps.waitForever ?? (() => new Promise(() => {}));
    const allConflictSignalM = multiDaemon.allConflict ?? new Promise(() => {});
    const outcomeM = await Promise.race([
      waitForeverM().then(() => 0),
      allConflictSignalM.then(() => ALL_CONFLICT_M),
    ]);
    if (outcomeM === ALL_CONFLICT_M) {
      errLog(
        `[Chorus] every declared path for every agent is already served by a live daemon — ` +
          `nothing to do. Stop the other daemon(s) or remove the conflicting path(s), then restart.`,
      );
      await multiDaemon.stop();
      return 1;
    }
    return 0;
  }

  // Foreground preflight: resolve/complete credentials + resolve the permission
  // posture (confirming yolo on a TTY). Reuses the same pfDeps bundle the detach
  // path uses. Returns a numeric exit code on failure, or
  // { creds, identity, permissionMode } on success.
  const pf = await preflight(pfDeps);
  if (typeof pf === "number") return pf;
  const { creds, identity, permissionMode } = pf;

  // Detect the SELECTED backend's executable (non-fatal): the daemon still
  // subscribes when it's missing; a wake surfaces the error visibly when one
  // arrives. The resolved path (or absence) is shown in the banner below. Each
  // backend probes its own binary — codex → resolveCodexPath, kiro →
  // resolveKiroPath, otherwise resolveClaudePath — so a `--agent kiro` run probes
  // (and the banner reports) `kiro-cli`, not `claude`.
  const cliPath =
    agentType === "codex" ? findCodex() : agentType === "kiro" ? findKiro() : findClaude();

  // The daemon.json the layered config readers (credentials, sigint timeout, cwds)
  // consult. Surfacing its absolute path + presence in the banner makes it obvious
  // which file to edit for `cwds` / `sigintTimeoutMs` and whether one exists at all.
  const configPath = loginFilePath();
  const configExists = existsSync(configPath);

  // Boxed startup banner — one screen replacing the scattered [Chorus] lines.
  log(
    formatBanner(
      {
        version,
        url: creds.url,
        agentName: identity.name,
        agentUuid: identity.uuid,
        permissionMode,
        credentialSource: creds.source,
        agentType,
        cliPath,
        connection: "connecting…",
        configPath,
        configExists,
      },
      { isTTY: isTTY && Boolean(process.stdout.isTTY) }
    )
  );
  // The yolo posture is loud even when the banner scrolls past — keep the one-line
  // ⚠ warning on stderr (it also names --chorus-only as the reclaim switch).
  if (permissionMode === "yolo") {
    errLog(`[Chorus] ${yoloWarningLine()}`);
  }
  // A missing backend binary is non-fatal (the daemon still subscribes), but the
  // banner row alone is easy to miss in a systemd journal — emit one loud ⚠ line
  // on stderr so the operator sees it at startup, not only when a wake fails. The
  // warning names the SELECTED backend (claude / CHORUS_CLAUDE_PATH or codex /
  // CHORUS_CODEX_PATH).
  if (cliPath === null) {
    errLog(`[Chorus] ${agentNotFoundWarningLine(agentType)}`);
  }

  // Surface the served paths so an operator sees a multi-path daemon at a glance.
  // A single `[undefined]` (the default) prints the process cwd it falls back to.
  const servedPaths = cwds.map((c) => c ?? process.cwd());
  if (servedPaths.length > 1) {
    log(`[Chorus] serving ${servedPaths.length} paths: ${servedPaths.join(", ")}`);
  } else {
    log(`[Chorus] serving path: ${servedPaths[0]}`);
  }
  log(`[Chorus] browse roots: ${browseRoots.join(", ")} (discovery only; no connections created)`);

  const daemon = build(creds, {
    logger: { info: log, warn: errLog, error: errLog },
    permissionMode,
    agentType,
    verbose,
    sigintTimeoutMs,
    cwds,
    browseRoots,
  });

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

  // Keep the process alive for the long-lived SSE subscription, but exit non-zero if
  // EVERY declared path turns out to be already served by a live daemon
  // (add-daemon-connection-conflict-skip, Q3). `daemon.allConflict` settles only in
  // that all-paths-conflicted case; otherwise we wait forever on the subscription. A
  // sentinel distinguishes the two so a waitForever that never settles can't be mistaken
  // for the conflict exit.
  const ALL_CONFLICT = Symbol("all-conflict");
  const waitForever = deps.waitForever ?? (() => new Promise(() => {}));
  // `daemon.allConflict` is present on the real buildDaemon output; guard for injected
  // test fakes that don't provide it (those never settle the conflict branch). A
  // never-settling fallback keeps the race purely waitForever-driven in that case.
  const allConflictSignal =
    daemon.allConflict ?? new Promise(() => {});
  const outcome = await Promise.race([
    waitForever().then(() => 0),
    allConflictSignal.then(() => ALL_CONFLICT),
  ]);
  if (outcome === ALL_CONFLICT) {
    const n = servedPaths.length;
    errLog(
      `[Chorus] all ${n} declared ${n === 1 ? "path is" : "paths are"} already served by a live daemon — nothing to do. ` +
        `Stop the other daemon(s) or remove the conflicting path(s), then restart.`
    );
    await daemon.stop();
    return 1;
  }
  return 0;
}

/**
 * Foreground preflight shared by the normal and `-d` startup paths: resolve or
 * interactively complete credentials, validate identity, and resolve the
 * permission posture (confirming + persisting the yolo ack on a TTY). All the
 * interactive IO lives here so it always runs in a real terminal before any
 * detach. Returns a numeric exit code on failure, or
 * { creds, identity, permissionMode } on success.
 * @returns {Promise<number | { creds: any, identity: any, permissionMode: "yolo"|"chorus" }>}
 */
export async function preflight(ctx) {
  const { flags, env, isTTY, resolve, validate, writeCreds, askPrompt, log, errLog } = ctx;

  let creds;
  // `identity` may be pre-filled by interactive completion (it validates as part
  // of completing), so the main validate step is skipped when it's already set.
  let identity = null;
  try {
    creds = resolve(flags);
  } catch (err) {
    // No resolvable credentials. On a TTY, complete them interactively (reusing
    // the `chorus login` masked-prompt → validate → 0600 persist flow). On a
    // non-TTY (systemd / nohup / CI / detached child), preserve the hard error +
    // multi-source hint — never block on a prompt no one can answer.
    if (!isTTY) {
      errLog(err instanceof Error ? err.message : String(err));
      return 1;
    }
    log("[Chorus] no credentials found — completing them interactively (saved for next time).");
    let url = await askPrompt("Chorus URL: ");
    let apiKey = await askPrompt("Chorus API key (cho_...): ", { mask: true });
    url = (url || "").trim();
    apiKey = (apiKey || "").trim();
    if (!url || !apiKey) {
      errLog("[Chorus] both a URL and an API key are required — aborting.");
      return 1;
    }
    try {
      identity = await validate({ url, apiKey });
    } catch (verr) {
      errLog(`[Chorus] credential validation failed: ${verr instanceof Error ? verr.message : String(verr)}`);
      errLog("[Chorus] credentials were NOT saved.");
      return 1;
    }
    writeCreds({ url, apiKey, agentUuid: identity.uuid, agentName: identity.name });
    creds = { url, apiKey, source: "interactive" };
  }
  log(`[Chorus] credentials resolved from: ${creds.source}`);

  if (!identity) {
    try {
      identity = await validate({ url: creds.url, apiKey: creds.apiKey });
    } catch (err) {
      errLog(`[Chorus] credential validation failed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  log(`[Chorus] authenticated as ${identity.name} (${identity.uuid})`);

  // Permission posture: default yolo. --chorus-only reclaims the restricted posture.
  const decision = resolvePermissionMode(flags, env, { isTTY, hasAck: false });

  return { creds, identity, permissionMode: decision.mode };
}

/**
 * Dispatch a daemon lifecycle subcommand. Two families:
 *   - install / uninstall — manage the boot-autostart supervisor service
 *     (systemd --user on Linux; a printed template on macOS/Windows).
 *   - status / stop / restart / logs — when a supervisor unit is installed and
 *     active, DELEGATE to it (systemctl / journalctl) so a supervised daemon is
 *     never misreported as "not running"; otherwise operate on the
 *     pidfile/logfile-managed `-d` background daemon exactly as before.
 * Each reports clearly (no silent failure). `restart` performs
 * stop-then-detached-start on the pidfile path.
 * @returns {Promise<number>} exit code
 */
export async function handleLifecycleAction(action, { log, errLog, lifecycle, service, pfDeps }) {
  // The supervisor seam is optional (older test bundles inject only lifecycle);
  // a no-op fallback keeps those callers on the pure pidfile path.
  const svc = service ?? { detectSupervisor: () => ({ kind: "none" }) };

  if (action === "install") {
    // Pre-install config phase (fix-daemon-install-config): BEFORE writing any
    // unit, guarantee the clean-env boot service can authenticate and knows which
    // cwds to serve. --yes/-y OR a non-TTY suppress prompts; neither suppresses
    // the resolve/persist/validate/abort guarantee.
    const flags = pfDeps?.flags ?? {};
    const env = pfDeps?.env ?? {};
    const isTTY = pfDeps?.isTTY ?? false;
    const skip = flags.yes === true || !isTTY;
    const installCfg = svc.installConfig ?? {
      resolveInstallCredentials,
      resolveInstallCwds,
      resolveInstallBrowseRoots,
      resolveInstallAgent,
    };

    const credResult = await installCfg.resolveInstallCredentials(flags, env, {
      isTTY,
      skip,
      resolve: pfDeps?.resolve,
      validate: pfDeps?.validate,
      writeConfig: pfDeps?.writeConfig ?? updateDaemonConfig,
      prompt: pfDeps?.askPrompt,
      log,
      errLog,
    });
    if (!credResult.ok) {
      // Credentials could not be obtained / validated — never install a service
      // that would fail to authenticate and crash-loop at boot.
      errLog("[Chorus] install aborted — no service was written.");
      return 1;
    }

    // Configure + persist the served cwd set (single source of truth in
    // daemon.json; the unit carries no --cwd). Never blocks on a non-TTY.
    // readJson / loginPath are optional injectable seams (default to the real
    // login file) so the config phase can be exercised hermetically in tests.
    await installCfg.resolveInstallCwds(flags, {
      isTTY,
      skip,
      writeConfig: pfDeps?.writeConfig ?? updateDaemonConfig,
      readJson: pfDeps?.readJson,
      loginPath: pfDeps?.loginPath,
      prompt: pfDeps?.askPrompt,
      log,
    });
    if (installCfg.resolveInstallBrowseRoots) {
      await installCfg.resolveInstallBrowseRoots(flags, {
        writeConfig: pfDeps?.writeConfig ?? updateDaemonConfig,
        readJson: pfDeps?.readJson,
        loginPath: pfDeps?.loginPath,
      });
    }

    // Configure + persist the agent backend to daemon.json `agent` (single source
    // of truth; the unit carries no --agent, exactly like --cwd). Prompts an
    // interactive menu on a TTY (Enter = claude-code); reuses a --agent flag /
    // CHORUS_AGENT env / a prior stored choice; probes the selected CLI and warns
    // (non-fatal) when it is missing. An unknown --agent was already rejected by
    // resolveAgentType above, so this phase never fails.
    await installCfg.resolveInstallAgent(flags, env, {
      isTTY,
      skip,
      writeConfig: pfDeps?.writeConfig ?? updateDaemonConfig,
      readJson: pfDeps?.readJson,
      loginPath: pfDeps?.loginPath,
      prompt: pfDeps?.askPrompt,
      log,
      errLog,
    });

    const spec = {
      ...svc.resolveServicePaths(),
      cwds: flags.cwd ?? [],
      // NOTE: agent is deliberately NOT passed into the unit. The selected backend
      // is persisted to daemon.json `agent` (single source of truth) and read back
      // by the daemon via resolveAgentType — mirroring how --cwd is handled. Baking
      // --agent into ExecStart too would let the two sources drift.
      chorusOnly: flags.chorusOnly === true,
      workingDir: process.cwd(),
    };
    const r = svc.installService(spec);
    if (r.installed) {
      log(`[Chorus] installed and started the daemon service:`);
      for (const s of r.steps) log(`[Chorus]   ${s}`);
      log(`[Chorus] it will now start automatically at login. Manage it with:`);
      log(`[Chorus]   chorus daemon status | stop | restart | logs`);
      // A --user service only survives logout with lingering enabled; and a
      // separately-started `chorus daemon -d` would hold the same paths and make
      // this service exit-and-retry. Surface both so neither is a silent gotcha.
      log(`[Chorus] to keep it running after you log out: loginctl enable-linger "$USER"`);
      log(`[Chorus] if you previously ran 'chorus daemon -d', stop it first ('chorus daemon stop') so it doesn't hold the same paths.`);
      return 0;
    }
    if (r.platform === "linux") {
      // Linux install actually failed (write / systemctl error) — surface it.
      errLog(`[Chorus] service install failed: ${r.error}`);
      for (const s of r.steps) errLog(`[Chorus]   (did: ${s})`);
      return 1;
    }
    // macOS / Windows: not auto-installed by design — print the template + steps.
    log(`[Chorus] automatic install is Linux-only. To run the daemon as a service on this platform:`);
    for (const s of r.steps) log(`[Chorus]   ${s}`);
    log("");
    log(r.unitText);
    return 0;
  }
  if (action === "uninstall") {
    const r = svc.uninstallService();
    if (r.platform === "linux") {
      if (r.error) {
        errLog(`[Chorus] service uninstall failed: ${r.error}`);
        return 1;
      }
      if (r.removed) {
        log(`[Chorus] removed the daemon service:`);
        for (const s of r.steps) log(`[Chorus]   ${s}`);
      } else {
        log(`[Chorus] no installed daemon service found (nothing to remove).`);
      }
      return 0;
    }
    log(`[Chorus] automatic uninstall is Linux-only. To remove the service on this platform:`);
    for (const s of r.steps) log(`[Chorus]   ${s}`);
    return 0;
  }

  // For the control verbs, prefer a live supervisor unit over the pidfile.
  const sup = svc.detectSupervisor();
  const supervised = sup.kind === "systemd" && sup.installed;

  if (action === "status") {
    if (supervised) {
      log(`[Chorus] daemon is managed by systemd (${SERVICE_NAME}.service) — ${sup.active ? "active" : "installed but NOT active"}.`);
      const r = svc.systemctlUser(["status", "--no-pager", `${SERVICE_NAME}.service`]);
      if (r.stdout) log(r.stdout.trimEnd());
      return sup.active ? 0 : 1;
    }
    const s = lifecycle.isRunning();
    if (s.running) log(`[Chorus] daemon is running (pid ${s.pid}).`);
    else if (s.stale) log(`[Chorus] daemon is NOT running (stale pidfile for pid ${s.pid}).`);
    else log("[Chorus] daemon is not running.");
    return 0;
  }
  if (action === "logs") {
    if (supervised) {
      const r = svc.journalctlUser(["-u", `${SERVICE_NAME}.service`, "--no-pager", "-n", "200"]);
      if (r.status !== 0 && !r.stdout) {
        errLog(`[Chorus] could not read the service journal: ${r.stderr.trim() || `exit ${r.status}`}`);
        return 1;
      }
      log(r.stdout.trimEnd());
      return 0;
    }
    const r = lifecycle.readLog();
    if (!r.ok) {
      errLog(`[Chorus] ${r.message}`);
      return 1;
    }
    log(r.content);
    return 0;
  }
  if (action === "stop") {
    if (supervised) {
      const r = svc.systemctlUser(["stop", `${SERVICE_NAME}.service`]);
      if (r.status === 0) {
        log(`[Chorus] stopped the daemon service (systemctl --user stop ${SERVICE_NAME}.service).`);
        log(`[Chorus] note: it is still enabled and will start again at next login. To disable: chorus daemon uninstall`);
        return 0;
      }
      errLog(`[Chorus] failed to stop the service: ${r.stderr.trim() || `exit ${r.status}`}`);
      return 1;
    }
    // --force: unconditional pidfile cleanup for stuck states the identity
    // probe cannot resolve. Threaded from the parsed client flags.
    const r = lifecycle.stopDaemon({ force: pfDeps?.flags?.force === true });
    // Exit 0 whenever the end state is "no daemon, no pidfile" (stopped /
    // stale-cleared / forced) so `chorus daemon stop && …` chains survive a
    // self-heal; 1 for not-running and signal errors.
    const ok = r.reason === "stopped" || r.reason === "stale-cleared" || r.reason === "forced";
    (ok ? log : errLog)(`[Chorus] ${r.message}`);
    return ok ? 0 : 1;
  }
  if (action === "restart") {
    if (supervised) {
      const r = svc.systemctlUser(["restart", `${SERVICE_NAME}.service`]);
      if (r.status === 0) {
        log(`[Chorus] restarted the daemon service (systemctl --user restart ${SERVICE_NAME}.service).`);
        return 0;
      }
      errLog(`[Chorus] failed to restart the service: ${r.stderr.trim() || `exit ${r.status}`}`);
      return 1;
    }
    const r = lifecycle.stopDaemon();
    log(`[Chorus] ${r.message}`);
    // Start a fresh detached instance regardless of whether one was running.
    return startDetached({ log, errLog, lifecycle, pfDeps, skipPreflight: true });
  }
  errLog(`[Chorus] unknown daemon action: ${action}`);
  return 1;
}

/**
 * `-d` / --detach: run the foreground preflight (in this TTY), then spawn the
 * daemon detached (re-exec self without `-d`, with the DETACHED_ENV marker so
 * the child skips the preflight), write the pidfile, and return. Refuses to
 * double-start when a live daemon is already recorded.
 *
 * `skipPreflight` (used by restart) bypasses the interactive preflight — restart
 * runs non-interactively against already-persisted credentials/ack.
 * @returns {Promise<number>} exit code
 */
export async function startDetached(ctx) {
  const { log, errLog, lifecycle, pfDeps, skipPreflight } = ctx;
  const env = pfDeps.env ?? process.env;

  // Refuse to double-start before doing any interactive work.
  const status = lifecycle.isRunning();
  if (status.running) {
    errLog(`[Chorus] a daemon is already running (pid ${status.pid}). Use 'chorus daemon stop' first.`);
    return 1;
  }

  if (!skipPreflight) {
    // Run the SAME (injectable) preflight as the foreground path, in THIS TTY,
    // before detaching — so credential completion + the yolo y/N confirm happen
    // where a human can answer them.
    const pf = await preflight(pfDeps);
    if (typeof pf === "number") return pf; // preflight failed (e.g. declined yolo)
  }

  // Re-exec this same chorus entry without `-d` (so the child runs the daemon),
  // marking it DETACHED so it skips the interactive preflight.
  const nodePath = process.execPath;
  const scriptArgs = process.argv.slice(1).filter((a) => a !== "-d" && a !== "--detach");
  const result = lifecycle.startBackground({
    nodePath,
    args: scriptArgs,
    env: { ...env, [DETACHED_ENV]: "1" },
    cwd: process.cwd(),
  });

  if (result.alreadyRunning) {
    errLog(`[Chorus] a daemon is already running (pid ${result.pid}).`);
    return 1;
  }
  log(`[Chorus] daemon started in background (pid ${result.pid}).`);
  log(`[Chorus]   logs:  chorus daemon logs   (${result.logFile})`);
  log(`[Chorus]   stop:  chorus daemon stop`);
  return 0;
}

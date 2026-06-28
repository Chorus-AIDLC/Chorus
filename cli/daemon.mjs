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
// Connection / session / transcript reporting to the server is intentionally
// NOT done here — the no-op UploadHooks reserve those seams for the derived
// observability idea.

import { resolveCredentials, loginFilePath } from "./credentials.mjs";
import { prompt, writeLoginFile } from "./login.mjs";
import {
  resolvePermissionMode,
  yoloWarningLine,
} from "./daemon-permission-mode.mjs";
import { resolveAgentType } from "./daemon-agent.mjs";
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
import { selectSpawner } from "./spawner-select.mjs";
import {
  createExecutionUploadHooks,
  createTranscriptUploadHooks,
  mergeUploadHooks,
} from "./upload-hooks.mjs";
import { WAKE_ACTIONS } from "./prompts.mjs";
import { createInterruptReporter } from "./interrupt-reporter.mjs";
import { createTurnReporter } from "./turn-reporter.mjs";
import { createControlHandler } from "./control-handler.mjs";
import { resolveSigintTimeoutMs, resolveDaemonCwds } from "./daemon-config.mjs";
import {
  startBackground,
  stopDaemon,
  isRunning,
  readLog,
} from "./daemon-lifecycle.mjs";
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
  // The WakeQueue serializes per DIRECT idea (keyFor's key). It is shared across all
  // path-connections: serialization-per-idea still holds, and maxConcurrency caps the
  // whole process's in-flight wakes rather than per-cwd — the right global budget.
  const queue = new WakeQueue({ maxConcurrency: deps.maxConcurrency ?? 4, logger });

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

    /** @type {Waker|undefined} */
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
          getSnapshot: () => waker?.buildExecutionSnapshot() ?? [],
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
    waker = new Waker({ creds, lineage, spawner, cwd, hooks, logger, reportInterrupt, advanceTurn, verbose });
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
    const redispatchResume = (entityType, entityUuid) => {
      router.dispatchResume?.({ entityType, entityUuid });
    };
    const deliverTurn = (turnUuid) => backfill?.pendingTurnsOnly?.(turnUuid);
    const onControl = createControlHandler({
      waker,
      getConnectionUuid: () => connectionState.connectionUuid,
      sigintTimeoutMs,
      redispatchResume,
      deliverTurn,
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
        },
        onControl,
        onReconnect: backfill,
        logger,
      });

    return { cwd, connectionState, waker, router, backfill, sseListener, hooks };
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
    queue,
    // Back-compat single-connection aliases (the common single-path case). The full
    // set is exposed as `connections` for multi-path inspection/tests.
    waker: primary.waker,
    router: primary.router,
    sseListener: primary.sseListener,
    connections,
    async start() {
      // Connect every path-connection. Each fires its own onConnect hook + SSE connect;
      // the daemon process cwd is untouched (NFR-3).
      for (const c of connections) {
        await c.hooks.onConnect?.({ host: creds.url });
        await c.sseListener.connect();
      }
    },
    async stop() {
      for (const c of connections) {
        c.sseListener.disconnect?.();
      }
      // The MCP client is process-wide (shared) — disconnect it once.
      await mcpClient.disconnect?.();
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
  const lifecycle = deps.lifecycle ?? { startBackground, stopDaemon, isRunning, readLog };
  // The preflight dep bundle — built from the same seams runDaemon resolved, so
  // the detach/restart paths run the SAME (injectable) preflight, not the real
  // implementations. Threaded into startDetached so tests can drive it offline.
  const pfDeps = { flags, env, isTTY, resolve, validate, writeCreds, askPrompt, log, errLog };

  const action = flags.action ?? "run";
  if (action !== "run") {
    return handleLifecycleAction(action, { log, errLog, lifecycle, pfDeps });
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

  // Foreground preflight: resolve/complete credentials + resolve the permission
  // posture (confirming yolo on a TTY). Reuses the same pfDeps bundle the detach
  // path uses. Returns a numeric exit code on failure, or
  // { creds, identity, permissionMode } on success.
  const pf = await preflight(pfDeps);
  if (typeof pf === "number") return pf;
  const { creds, identity, permissionMode } = pf;

  // Detect the SELECTED backend's executable (non-fatal): the daemon still
  // subscribes when it's missing; a wake surfaces the error visibly when one
  // arrives. The resolved path (or absence) is shown in the banner below. codex
  // → resolveCodexPath, otherwise resolveClaudePath — so a `--agent codex` run
  // probes (and the banner reports) `codex`, not `claude`.
  const cliPath = agentType === "codex" ? findCodex() : findClaude();

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

  const daemon = build(creds, {
    logger: { info: log, warn: errLog, error: errLog },
    permissionMode,
    agentType,
    verbose,
    sigintTimeoutMs,
    cwds,
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

  // Keep the process alive for the long-lived SSE subscription.
  await (deps.waitForever ?? (() => new Promise(() => {})))();
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
 * Dispatch a daemon lifecycle subcommand (stop/status/restart/logs) against the
 * pidfile/logfile-managed background daemon. Each reports clearly when nothing
 * is running (no silent failure). `restart` performs stop-then-detached-start.
 * @returns {Promise<number>} exit code
 */
export async function handleLifecycleAction(action, { log, errLog, lifecycle, pfDeps }) {
  if (action === "status") {
    const s = lifecycle.isRunning();
    if (s.running) log(`[Chorus] daemon is running (pid ${s.pid}).`);
    else if (s.stale) log(`[Chorus] daemon is NOT running (stale pidfile for pid ${s.pid}).`);
    else log("[Chorus] daemon is not running.");
    return 0;
  }
  if (action === "logs") {
    const r = lifecycle.readLog();
    if (!r.ok) {
      errLog(`[Chorus] ${r.message}`);
      return 1;
    }
    log(r.content);
    return 0;
  }
  if (action === "stop") {
    const r = lifecycle.stopDaemon();
    (r.stopped ? log : errLog)(`[Chorus] ${r.message}`);
    return r.stopped ? 0 : 1;
  }
  if (action === "restart") {
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

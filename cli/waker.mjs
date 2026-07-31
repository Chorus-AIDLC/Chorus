// cli/waker.mjs
// Executes a single wake: resolve the event to its idea attribution, derive the
// deterministic session id (= the DIRECT idea uuid), build the --mcp-config, spawn
// the configured headless agent, and
// fire the (no-op) upload hooks. The WakeQueue schedules these per DIRECT idea so
// two wakes for the same idea never run concurrently against the same session.
//
// TWO-ID CONTRACT (do not conflate): the session is anchored on the DIRECT idea
// (so a human can `claude --resume <idea-uuid>`), while the execution snapshot
// reports the ROOT idea (for the observability UI). Both ids come from one lineage
// resolution and are threaded SEPARATELY — the root reported in the snapshot is
// the server-resolved root, NEVER re-derived from the (direct-idea) serialization
// key.
//
// Module contract (design.md): Waker.wake(notification, key, attribution) →
// Promise<void>. A failure is logged and swallowed — it must never crash the
// daemon (no-silent-errors: visible log, no throw).

import { buildPrompt } from "./prompts.mjs";
import { writeMcpConfig } from "./mcp-config.mjs";
import { isNewSession } from "./claude-spawner.mjs";
import { killProcessTree, DEFAULT_SIGINT_TIMEOUT_MS } from "./process-killer.mjs";

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

export class Waker {
  /**
   * @param {{
   *   creds: { url: string, apiKey: string },
   *   lineage: { resolve: (event: any) => Promise<{ rootIdeaUuid: string|null, directIdeaUuid: string|null }> },
   *   spawner: { wake: (params: any) => Promise<{ sessionId: string, exitCode: number|null, isNew: boolean }> },
   *   cwd?: string,  The connection/session-bound working directory this Waker serves; resolveCwd() is the single source the probe + spawn + resume use. `undefined` ⇒ the process default cwd (HARD-1 / single-path).
   *   hooks?: import("./upload-hooks.mjs").UploadHooks,
   *   logger?: { info(m:string):void, warn(m:string):void, error(m:string):void },
   *   writeMcpConfigFn?: typeof writeMcpConfig,
   *   isNewSessionFn?: typeof isNewSession,  Injectable for tests (disk probe).
   *   reportInterrupt?: (entityType: string, entityUuid: string, reason: "user"|"crash") => Promise<void>,
   *     Injectable interrupt reporter (子3). Called when a wake's subprocess exits in
   *     an interrupted (user) or crashed (non-zero, no interrupt flag) state. Defaults
   *     to a no-op that logs — the daemon wires the REST reporter (interrupt-reporter.mjs).
   *   advanceTurn?: (params: { sessionId: string, backendSessionId?: string|null, status: "running"|"ended"|"interrupted", entityType?: string|null, entityUuid?: string|null, interruptedReason?: "user"|"crash"|"shutdown", transcriptRelayError?: string|null, usage?: import("./upload-hooks.mjs").TokenUsage|null }) => Promise<void>,
   *     Injectable turn-lifecycle reporter (子1 — daemon-session-conversation). Called
   *     on spawn (→ running) and on subprocess exit (→ ended on a clean exit, or
   *     → interrupted with the classified reason otherwise) to advance the server-side
   *     DaemonSessionTurn the notification chokepoint created (status `pending`). The
   *     server resolves the turn by the session business key (`sessionId`) and stamps
   *     the weak executionUuid link from entityType/entityUuid. Defaults to a no-op that
   *     logs — the daemon wires the REST reporter (turn-reporter.mjs).
   *   killer?: (child: any, opts: any) => Promise<any>,  Injectable kill escalation for
   *     interruptAll(); defaults to process-killer.killProcessTree (cross-platform).
   *   sigintTimeoutMs?: number,  Escalation window interruptAll passes the killer.
   * }} opts
   */
  constructor(opts) {
    this.creds = opts.creds;
    this.lineage = opts.lineage;
    this.spawner = opts.spawner;
    // Verbose per-wake logging (daemon-startup-output). Default: one compact
    // line per lifecycle event (arrival / session decision / completion).
    // When true, additional detail is emitted alongside those lines.
    this.verbose = opts.verbose ?? false;
    // The connection/session-bound working directory this Waker serves (T3 — 单
    // daemon 多路径引擎). A daemon process may run SEVERAL Wakers, one per declared
    // path, each pinned to its own cwd; the daemon process's OWN cwd never changes
    // (NFR-3). `opts.cwd` is that bound path; `undefined` (unspecified / old daemon /
    // single-path default) degrades to the process cwd via resolveCwd(). Stored raw
    // so resolveCwd() is the SINGLE place the process-default fallback is applied
    // (Module Contract 1 — one cwd source of truth, no scattered process.cwd()).
    this.cwd = opts.cwd;
    this.hooks = opts.hooks;
    this.logger = opts.logger ?? NOOP_LOGGER;
    this.writeMcpConfigFn = opts.writeMcpConfigFn ?? writeMcpConfig;
    this.isNewSessionFn = opts.isNewSessionFn ?? isNewSession;
    // Interrupt reporter (子3): default no-op-with-log so a Waker built without one
    // (existing tests) keeps working; the daemon injects the REST reporter.
    this.reportInterrupt =
      opts.reportInterrupt ??
      (async (entityType, entityUuid, reason) => {
        this.logger.info(
          `[Chorus] (no reporter wired) would report ${entityType}:${entityUuid} interrupted (reason=${reason})`
        );
      });
    // Turn-lifecycle reporter (子1): default no-op-with-log so a Waker built without one
    // (existing tests) keeps working; the daemon injects the REST reporter
    // (turn-reporter.mjs). Advances the server-side turn pending→running on spawn and
    // running→ended on subprocess exit, identified by the session business key.
    this.advanceTurn =
      opts.advanceTurn ??
      (async ({ sessionId, status }) => {
        this.logger.info(
          `[Chorus] (no turn reporter wired) would advance turn for session ${sessionId} → ${status}`
        );
      });
    // Per-entity "interrupting" flags, set by the control handler the moment an
    // authorized interrupt is verified for a running child (markInterrupting). The
    // wake's exit path reads + clears it to decide reason=user vs reason=crash.
    /** @type {Set<string>} */
    this.interrupting = new Set();
    // Daemon graceful-shutdown flag (fix-daemon-exit-orphan-running-turn). Set once
    // by interruptAll() and never cleared — a shutting-down Waker is on its way out.
    // The wake exit path reads it to report the TURN as interrupted(shutdown), and to
    // SUPPRESS the execution interrupt report (a shutdown-kill would otherwise read as
    // a dirty exit → sticky interrupted(crash) execution row that reconcileOffline
    // deliberately skips — stranded in the UI on every Ctrl-C).
    this.shuttingDown = false;
    // Injectable killer for interruptAll (defaults to the shared cross-platform
    // escalation; tests inject a spy). Kill logic itself stays in process-killer.mjs.
    this.killer = opts.killer ?? killProcessTree;
    this.sigintTimeoutMs = opts.sigintTimeoutMs ?? DEFAULT_SIGINT_TIMEOUT_MS;

    // Per-resource execution registry — the source of truth for the execution
    // snapshot uploaded to the server. Keyed by `${entityType}:${entityUuid}`
    // (the wake-triggering notification's target resource), so a resource appears
    // at most once regardless of how many notifications target it. EVERY wake is
    // tracked — task, idea (@-mention / elaboration under an idea), proposal, and
    // document — not only task dispatches, so the server/UI can show "this daemon
    // is processing <resource>" for any wake. Each entry carries the rootIdeaUuid
    // the waker ALREADY resolved (reused, never re-walked) plus the daemon-side
    // status/startedAt.
    // The entry also holds the live `child` ChildProcess while RUNNING (子3) so the
    // control handler can target it for an interrupt. `child` is null while queued.
    // buildExecutionSnapshot() maps ONLY the serializable fields and NEVER emits
    // `child` — the handle stays daemon-local and never leaks onto the wire.
    // The entry also carries the `directIdeaUuid` the waker ALREADY resolved (the
    // entity's directly-attached idea — the same value used as the session anchor)
    // so the UI can match a conversation's execution by the DIRECT idea rather than
    // the root — surfacing a child idea's wake on the child conversation, not its
    // parent.
    /** @type {Map<string, { entityType: string, entityUuid: string, rootIdeaUuid: string|null, directIdeaUuid: string|null, status: "running"|"queued", startedAt: string|null, child: import("node:child_process").ChildProcess|null }>} */
    this.executions = new Map();
  }

  /**
   * The SINGLE source of truth for this Waker's working directory (Module Contract
   * 1 — 不变式安全 / cwd 事实源统一). transcript probing (new-vs-resume), spawn, and
   * resume ALL resolve cwd through here, so they can never diverge — a divergence
   * would make the on-disk transcript probe decide new-vs-resume against a different
   * directory than the one we spawn in (`claude --resume` is cwd-bound).
   *
   * Returns the connection/session-bound cwd when one was declared, else the daemon
   * process's own cwd. The process-default fallback lives ONLY here: `this.cwd` is
   * stored raw (possibly `undefined`) and `process.cwd()` is read at exactly this one
   * site — Module Contract 2's HARD-1 degrade path (an old daemon / unspecified cwd
   * behaves exactly as today, spawning at the process default). No other code in the
   * wake path reads `process.cwd()`.
   * @returns {string}
   */
  resolveCwd() {
    return this.cwd ?? process.cwd();
  }

  /**
   * Mark a running entity as INTERRUPTING (子3) — called by the control handler the
   * moment an authorized interrupt is verified, BEFORE the killer signals the child.
   * The wake's exit path reads this flag to report reason="user" (vs "crash"). Keyed
   * the same as the execution registry so a control event and a wake agree on the
   * entity. Idempotent; never throws.
   * @param {string} entityType @param {string} entityUuid
   */
  markInterrupting(entityType, entityUuid) {
    this.interrupting.add(this.#execKey(entityType, entityUuid));
  }

  /**
   * Daemon graceful shutdown (fix-daemon-exit-orphan-running-turn): mark this Waker
   * SHUTTING DOWN and kill every live wake subprocess via the shared graceful
   * escalation (SIGINT → SIGKILL after `sigintTimeoutMs`). The in-flight wake()
   * promises then run their normal exit path, which — seeing `shuttingDown` —
   * reports each turn `interrupted(shutdown)` and suppresses the execution
   * interrupt report. Idempotent; never throws (a failed kill is logged and left
   * to the server-side offline reconcile as the backstop).
   *
   * Returns after the kill signals are DISPATCHED — completion of the subprocesses
   * (and their turn reports) is observed by awaiting the wake promises, which the
   * daemon's stop() does with a bounded cap.
   */
  interruptAll() {
    this.shuttingDown = true;
    for (const [key, entry] of this.executions) {
      if (entry.status !== "running" || !entry.child) continue;
      try {
        Promise.resolve(
          this.killer(entry.child, { sigintTimeoutMs: this.sigintTimeoutMs, logger: this.logger }),
        ).catch((err) => {
          this.logger.warn(`[Chorus] shutdown: killProcessTree rejected for ${key}: ${err}`);
        });
      } catch (err) {
        this.logger.warn(`[Chorus] shutdown: kill dispatch failed for ${key}: ${err}`);
      }
    }
  }

  /** Recognized wake-triggering resource kinds the server's DaemonExecution accepts. */
  // `daemon_session` is the ad-hoc conversation's own execution entity (子3 follow-up):
  // an ad-hoc human_instruction wake has no task/idea/proposal/document behind it, so
  // its running/interrupted state is reported against the DaemonSession itself, keyed by
  // the session BUSINESS id (`sessionId`) — which is ALSO the Claude `--resume` anchor for
  // an ad-hoc session, so the execution entity, the per-session UI match key, and the
  // resume anchor are one and the same value (no identity divergence).
  static #EXECUTION_ENTITY_TYPES = new Set([
    "task",
    "idea",
    "proposal",
    "document",
    "daemon_session",
  ]);

  /**
   * Extract the resource an execution row keys on for this notification — its
   * `{ entityType, entityUuid }` — or null when the notification has no reportable
   * target (missing fields, or an entityType outside the recognized set). Every
   * recognized wake (task/idea/proposal/document) is reported, not only tasks.
   * @param {{ entityType?: string, entityUuid?: string }} notification
   * @returns {{ entityType: string, entityUuid: string }|null}
   */
  #entityOf(notification) {
    const { entityType, entityUuid } = notification ?? {};
    if (
      typeof entityType === "string" &&
      typeof entityUuid === "string" &&
      entityUuid.length > 0 &&
      Waker.#EXECUTION_ENTITY_TYPES.has(entityType)
    ) {
      return { entityType, entityUuid };
    }
    return null;
  }

  /** Registry key for a resource. */
  #execKey(entityType, entityUuid) {
    return `${entityType}:${entityUuid}`;
  }

  /**
   * Build the current execution snapshot for upload: one entry per tracked
   * resource (running or queued), carrying entityType/entityUuid, the reused
   * rootIdeaUuid, and the daemon-side status/startedAt. Returns a fresh array each
   * call so the caller can't mutate internal state. Never throws.
   * @returns {Array<{ entityType: string, entityUuid: string, rootIdeaUuid: string|null, directIdeaUuid: string|null, status: "running"|"queued", startedAt: string|null }>}
   */
  buildExecutionSnapshot() {
    return [...this.executions.values()].map((e) => ({
      entityType: e.entityType,
      entityUuid: e.entityUuid,
      rootIdeaUuid: e.rootIdeaUuid,
      directIdeaUuid: e.directIdeaUuid,
      status: e.status,
      startedAt: e.startedAt,
    }));
  }

  /**
   * Record the wake's resource as QUEUED and emit a fresh snapshot. Called by the
   * router at enqueue time (before the wake runs), so the server sees the resource
   * waiting even while it sits behind a same-direct-idea wake. The rootIdeaUuid is
   * the SERVER-RESOLVED root from `attribution` (NOT sliced from `key`, which now
   * carries the direct idea) — the two-id contract. A notification with no
   * reportable resource (missing fields, or an entityType outside the recognized
   * task/idea/proposal/document set) is ignored. Never throws.
   * @param {{ entityType?: string, entityUuid?: string }} notification
   * @param {string} key  The serialization key from keyFor (idea:<direct> | entity:…).
   * @param {{ rootIdeaUuid?: string|null, directIdeaUuid?: string|null }} [attribution]
   *   Server-resolved ids: `rootIdeaUuid` → execution snapshot grouping; `directIdeaUuid`
   *   → the session anchor the UI matches a conversation's execution by. Both threaded
   *   from `attribution`, NEVER sliced from `key`.
   */
  markQueued(notification, key, attribution) {
    const entity = this.#entityOf(notification);
    if (!entity) return;
    const execKey = this.#execKey(entity.entityType, entity.entityUuid);
    const rootIdeaUuid = attribution?.rootIdeaUuid ?? null;
    // The DIRECT idea (session anchor) the UI matches a conversation's execution by
    // — carried from the SAME server-resolved attribution as rootIdeaUuid, never
    // sliced from the key.
    const directIdeaUuid = attribution?.directIdeaUuid ?? null;
    const existing = this.executions.get(execKey);
    // Don't downgrade a running resource to queued if a duplicate dispatch
    // arrives while it's mid-wake; only (re)mark queued when not already running.
    if (existing && existing.status === "running") return;
    this.executions.set(execKey, {
      entityType: entity.entityType,
      entityUuid: entity.entityUuid,
      rootIdeaUuid,
      directIdeaUuid,
      status: "queued",
      startedAt: existing?.startedAt ?? null,
      // Queued entries hold no live child yet — only the running entry does (子3).
      child: null,
    });
    this.#emitExecutionChange();
  }

  /** Fire-and-forget snapshot upload. Never throws into the wake path. */
  #emitExecutionChange() {
    try {
      this.hooks?.onExecutionChange?.();
    } catch (err) {
      this.logger.warn(`[Chorus] execution-change hook failed: ${err}`);
    }
  }

  /**
   * Resolve an event to its serialization key + idea attribution WITHOUT running
   * the wake. Used by the router to enqueue under the right key and to pass the
   * resolved root down to markQueued/wake (so the snapshot's root is never derived
   * from the key). The key — and the Claude session anchor — is the DIRECT idea;
   * falls back to a per-entity key when there's no direct idea (so unrelated
   * entities still get their own serial lane). One lineage resolution (cached).
   * @param {any} notification
   * @returns {Promise<{ key: string, rootIdeaUuid: string|null, directIdeaUuid: string|null }>}
   */
  async keyFor(notification) {
    const { rootIdeaUuid, directIdeaUuid } = await this.lineage.resolve(notification);
    const key = directIdeaUuid
      ? `idea:${directIdeaUuid}`
      : `entity:${notification.entityType}:${notification.entityUuid}`;
    return { key, rootIdeaUuid, directIdeaUuid };
  }

  /**
   * Run one wake. Never throws.
   * @param {import("./prompts.mjs").NotificationDetail} notification
   * @param {string} key  The serialization key (from keyFor) — anchored on the direct idea.
   * @param {{ rootIdeaUuid?: string|null, directIdeaUuid?: string|null }} [attribution]
   *   Server-resolved ids from keyFor. `rootIdeaUuid` → execution snapshot;
   *   `directIdeaUuid` → the deterministic Claude session id (when the entity has
   *   an idea ancestor). When there is no direct idea, the session is anchored on
   *   the entity's own uuid instead (see below).
   */
  async wake(notification, key, attribution) {
    let cfg;
    const entity = this.#entityOf(notification);
    const execKey = entity ? this.#execKey(entity.entityType, entity.entityUuid) : null;
    // Both ids come from the resolved `attribution` (supplied by keyFor via the
    // router) and are threaded SEPARATELY — NEVER sliced from `key`. The ROOT idea
    // is reported in the snapshot; the DIRECT idea is the preferred session anchor.
    const rootIdeaUuid = attribution?.rootIdeaUuid ?? null;
    const directIdeaUuid = attribution?.directIdeaUuid ?? null;
    // Per-wake lifecycle logging: stamp the start so completion can report a
    // duration. `Date.now()` is fine here (runtime metric, not a resume seed).
    const startMs = Date.now();
    const target = entity ? `${entity.entityType}:${entity.entityUuid}` : key;
    try {
      const prompt = buildPrompt(notification);
      if (!prompt) {
        this.logger.info(`[Chorus] no wake prompt for action "${notification.action}" — skipping`);
        return;
      }

      // Lifecycle line 1 — arrival: which action targets which idea/task/entity.
      this.logger.info(`[Chorus] ▶ wake: ${notification.action} → ${target}`);

      // Transition this resource to RUNNING with a start timestamp and emit a
      // fresh snapshot, so the server/UI sees it leave the queue and begin
      // executing. Report the server-resolved ROOT idea (not the direct-idea key).
      // `child` starts null and is filled in by the spawner's onChild the moment the
      // subprocess spawns (子3) — so the control handler can target it for interrupt.
      if (entity && execKey) {
        this.executions.set(execKey, {
          entityType: entity.entityType,
          entityUuid: entity.entityUuid,
          rootIdeaUuid,
          directIdeaUuid,
          status: "running",
          startedAt: new Date().toISOString(),
          child: null,
        });
        this.#emitExecutionChange();
      }

      // Session anchor: the DIRECT idea uuid when the entity has an idea ancestor;
      // otherwise the entity's OWN uuid (quick task, standalone doc, non-idea
      // proposal). Both are deterministic Chorus uuids, so the session stays
      // human-resumable (`claude --resume <uuid>`) and same-entity wakes continue
      // the same session — and we never drop a wake just because there's no idea
      // (the daemon's headline `task_assigned` for a quick task must still spawn).
      // Decide new-vs-resume by probing the on-disk transcript in the SAME cwd we
      // spawn in. The spawner re-validates the id is a lowercase UUID before
      // spawning, so a garbage id surfaces visibly rather than misanchoring.
      const sessionId = directIdeaUuid ?? notification.entityUuid ?? null;
      // Resolve the connection/session-bound cwd ONCE for this wake (Module Contract
      // 1). The transcript probe and the spawn below BOTH use this same value, so a
      // session's repeated wakes/probes always land the same cwd (NFR-3) — and a
      // multi-path daemon's other Wakers (other cwds) never bleed in.
      const cwd = this.resolveCwd();
      const isNew = sessionId ? this.isNewSessionFn(sessionId, cwd) : true;

      // Spawners declare whether the shared transcript probe is authoritative
      // for their session decision. Missing metadata preserves the established
      // Claude-compatible logging contract for injected/third-party spawners.
      const sessionDecision = this.spawner.sessionDecision;
      const probeIsAuthoritative = sessionDecision?.probeIsAuthoritative !== false;
      if (probeIsAuthoritative) {
        const takeoverCommand = sessionDecision?.takeoverCommand ?? "claude --resume";
        this.logger.info(
          `[Chorus] ${isNew ? "spawning new" : "resuming"} session ${sessionId ?? "(none)"}` +
            (sessionId && takeoverCommand ? ` — take over with: ${takeoverCommand} ${sessionId}` : "")
        );
      } else {
        this.logger.info(`[Chorus] dispatching session ${sessionId ?? "(none)"}`);
      }
      if (this.verbose) {
        this.logger.info(`[Chorus]   cwd=${cwd} action=${notification.action} root=${rootIdeaUuid ?? "(none)"}`);
      }

      cfg = this.writeMcpConfigFn(this.creds);

      await this.hooks?.onSessionStart?.({ rootIdeaKey: key, sessionId: sessionId ?? "", isNew });

      // Turn lifecycle (子1): the server created a `pending` turn for this wake at the
      // notification chokepoint, keyed on the same session business key the daemon
      // anchors the Claude session on (`sessionId` = directIdeaUuid, or the entity uuid
      // for an ad-hoc session). Advance it pending→running the moment the subprocess
      // spawns (in onChild — guaranteed to fire only on a successful spawn), and
      // running→ended after it exits. `turnAdvancedToRunning` gates the ended report so
      // a spawn that never started (onChild never fired) does not attempt an illegal
      // pending→ended transition. There is no separate turn registry — the turn is
      // identified server-side by `sessionId`, which the waker already has here.
      let turnAdvancedToRunning = false;

      // Track the session id the stream reports so the transcript hook can use
      // it even before spawner.wake() returns. (Do NOT reference the awaited
      // `result` inside onMessage — it's in the temporal dead zone there.)
      let observedSessionId = sessionId ?? "";
      const result = await this.spawner.wake({
        prompt,
        sessionId,
        isNew,
        cwd,
        mcpConfigPath: cfg.path,
        // Capture the live child into the running execution entry the instant it
        // spawns (子3) so the control handler can interrupt it mid-wake. Guarded so
        // a re-keyed/dropped entry never throws here. ALSO advance the server turn
        // pending→running here (子1) — same hook keying, no parallel registry — since
        // this is the precise moment the subprocess actually started.
        onChild: (child) => {
          const entry = execKey ? this.executions.get(execKey) : null;
          if (entry && entry.status === "running") entry.child = child;
          if (sessionId) {
            turnAdvancedToRunning = true;
            // Fire-and-forget; #advanceTurn swallows + logs its own failures so a
            // turn-report error never crashes the spawn callback (no-silent-errors).
            this.#advanceTurn(sessionId, "running", entity).catch(() => {});
          }
        },
        onMessage: (message) => {
          if (message && typeof message.session_id === "string") observedSessionId = message.session_id;
          // Fire-and-forget transcript hook (子1): keeps only user/assistant text and
          // batch-POSTs to /api/daemon/transcript for the current turn. Warn-not-throw
          // inside the hook; the trailing .catch is belt-and-braces so a rejected hook
          // promise can never surface as an unhandled rejection in the wake path.
          this.hooks
            ?.onTranscriptMessage?.({ rootIdeaKey: key, sessionId: observedSessionId, message })
            .catch(() => {});
        },
      });

      if (result && !probeIsAuthoritative) {
        this.logger.info(
          `[Chorus] backend ${result.isNew ? "started new" : "resumed"} session ${result.sessionId ?? sessionId ?? "(none)"}`
        );
      }

      // No session map to persist anymore — the id is deterministic (= direct idea
      // uuid) and the next wake re-derives new-vs-resume from disk. Just log a
      // non-zero exit visibly (no-silent-errors).
      if (result && result.exitCode !== 0) {
        this.logger.warn(
          `[Chorus] wake for ${key} exited non-zero (${result.exitCode})`
        );
      }

      // Outcome classification for the exit reports below. Read the flags ONCE so the
      // turn report and the execution report can never disagree on the outcome:
      //   • clean exit (code 0)              → turn ended            (unchanged)
      //   • interrupting flag (user)         → turn interrupted(user)
      //   • shuttingDown (daemon SIGINT/TERM) → turn interrupted(shutdown)
      //   • dirty exit otherwise             → turn interrupted(crash)
      // User-interrupt outranks shutdown: the flag was set by an explicit authorized
      // interrupt before the shutdown began, and its execution-row semantics (sticky,
      // resumable) must be preserved.
      const wasInterrupting = entity && execKey ? this.interrupting.has(execKey) : false;
      const cleanExit = result && result.exitCode === 0;

      // Transcript flush-on-exit (fix #444): the subprocess has exited, but the transcript
      // hook batches user/assistant text on a short debounce — the LAST batch may still be
      // buffered right now. Flush it and AWAIT it BEFORE advancing the turn to a terminal
      // status, so the trailing reply is persisted while the turn is still `running` (the
      // server attaches transcript to the running turn). Without this, a clean-exiting wake
      // advanced straight to `ended` and the buffered reply was dropped → the "该回合没有
      // 保留对话记录" empty turn in #444. Guarded + non-throwing (onSessionEnd swallows its
      // own failures; this try is belt-and-braces) so a flush error never crashes the wake.
      // `onSessionEnd` returns `{ relayError }` — the final transcript-upload failure
      // reason (retry exhausted / non-2xx / network) when the reply was produced but never
      // reached Chorus, else null. Forwarded onto the terminal turn-advance below so the UI
      // can say "reply couldn't be uploaded (reason)" rather than the misleading "no reply
      // received" (fix #444 follow-up). Guarded — a hook failure never crashes the exit path
      // and simply leaves the annotation absent.
      let transcriptRelayError = null;
      // The turn's authoritative per-turn token usage (daemon-token-usage), captured from
      // the Claude Code `result` frame by the transcript hook and returned alongside
      // relayError from the SAME onSessionEnd call. Forwarded onto the terminal turn-advance
      // below so the server persists it. Null when the run emitted no result frame.
      let turnUsage = null;
      if (sessionId) {
        try {
          const outcome = await this.hooks?.onSessionEnd?.({ sessionId });
          transcriptRelayError = outcome?.relayError ?? null;
          turnUsage = outcome?.usage ?? null;
        } catch (err) {
          this.logger.warn(`[Chorus] onSessionEnd flush failed for ${key}: ${err}`);
        }
      }

      // Turn lifecycle: the subprocess has exited — advance the server turn from
      // `running` to its OUTCOME-AWARE terminal state (fix-daemon-exit-orphan-running-
      // turn): `ended` on a clean exit, `interrupted` with the classified reason
      // otherwise — mirroring what the execution row records, so the conversation
      // history says WHY a turn stopped. Only when it actually reached `running` (a
      // never-spawned wake left the turn `pending`; a pending→<terminal> skip is
      // rejected server-side as invalid_transition). Swallow-safe; never throws.
      if (sessionId && turnAdvancedToRunning) {
        if (cleanExit) {
          // A clean exit with a KNOWN relay drop is the exact #444 signature: the reply
          // ran but its transcript never landed. Annotate the (still-clean) `ended` turn.
          // `turnUsage` rides the same terminal advance (daemon-token-usage).
          await this.#advanceTurn(sessionId, "ended", entity, null, transcriptRelayError, turnUsage, result?.backendSessionId);
        } else {
          const reason = wasInterrupting ? "user" : this.shuttingDown ? "shutdown" : "crash";
          await this.#advanceTurn(sessionId, "interrupted", entity, reason, transcriptRelayError, turnUsage, result?.backendSessionId);
        }
      }

      // Interrupt-vs-crash EXECUTION reporting (子3, Tech Design "Interrupt vs crash
      // reporting"). Decide from the same flags as the turn report above:
      //   • interrupting flag set            → interrupted(reason="user")
      //   • no flag AND non-zero/null exit    → interrupted(reason="crash")
      //   • clean exit (code 0)               → nothing (unchanged)
      // EXCEPT during shutdown (fix-daemon-exit-orphan-running-turn, review blocker
      // 2): a shutdown-killed subprocess exits dirty with no user flag, which would
      // record the STICKY execution state interrupted(crash) — a state the execution
      // offline-reconcile deliberately SKIPS and the read gate keeps showing, so
      // every Ctrl-C would strand a crash-interrupted row in the UI. During shutdown
      // report NO execution interrupt (user-interrupt still reports — its sticky
      // resumability is the point); the row is left for reconcileOffline to flip
      // `ended` when this connection's stream drops.
      if (entity && execKey) {
        if (wasInterrupting) {
          await this.#report(entity, "user");
        } else if (!cleanExit && !this.shuttingDown) {
          // No interrupt requested but the subprocess did not exit cleanly (non-zero
          // code, or null from a spawn/transport failure) → treat as a crash.
          await this.#report(entity, "crash");
        }
      }

      // Lifecycle line 3 — completion: duration + exit code, one compact line.
      const durationMs = Date.now() - startMs;
      this.logger.info(
        `[Chorus] ✓ wake done: ${target} (exit=${result?.exitCode ?? "?"}, ${durationMs}ms)`
      );
      if (this.verbose) {
        this.logger.info(
          `[Chorus]   action=${notification.action} session=${result?.sessionId} key=${key}`
        );
      }
    } catch (err) {
      this.logger.warn(`[Chorus] wake failed for ${key}: ${err}`);
    } finally {
      // Wake finished (cleanly or not): the resource leaves the active set. Drop
      // it and emit a fresh snapshot so the server ends its running/queued row.
      // The server reconcile is snapshot-authoritative, so absence == ended. Also
      // clear the per-entity interrupting flag so it can never leak into a later
      // wake of the same entity.
      if (execKey) {
        this.interrupting.delete(execKey);
        if (this.executions.delete(execKey)) {
          this.#emitExecutionChange();
        }
      }
      try {
        cfg?.cleanup?.();
      } catch {
        // best-effort
      }
    }
  }

  /**
   * Report an interrupted/crashed outcome via the injected reporter. Never throws
   * into the wake path — a reporter failure is logged and swallowed (the reporter
   * itself already swallows, this is belt-and-braces).
   * @param {{ entityType: string, entityUuid: string }} entity
   * @param {"user"|"crash"} reason
   */
  async #report(entity, reason) {
    try {
      await this.reportInterrupt(entity.entityType, entity.entityUuid, reason);
    } catch (err) {
      this.logger.warn(
        `[Chorus] reportInterrupt failed for ${entity.entityType}:${entity.entityUuid} (${reason}): ${err}`
      );
    }
  }

  /**
   * Advance the server-side DaemonSessionTurn for this wake (子1) via the injected
   * reporter. Identified server-side by the session business key (`sessionId`); the
   * optional `entity` ({ entityType, entityUuid }) lets the server stamp the weak
   * executionUuid link from the live execution row. An `interrupted` status carries
   * its classified `interruptedReason` (user/crash/shutdown). Never throws into the
   * wake path — a reporter failure is logged and swallowed (the REST reporter
   * already swallows; this is belt-and-braces, matching #report).
   *
   * `transcriptRelayError` (fix #444 follow-up) annotates a terminal turn whose transcript
   * upload finally failed — the reply was produced but never reached Chorus. Forwarded only
   * when set (a clean relay leaves it null so the field stays absent from the payload).
   * @param {string} sessionId @param {"running"|"ended"|"interrupted"} status
   * @param {{ entityType: string, entityUuid: string }|null} entity
   * @param {"user"|"crash"|"shutdown"|null} [interruptedReason]
   * @param {string|null} [transcriptRelayError]
   * @param {import("./upload-hooks.mjs").TokenUsage|null} [usage]  Per-turn token usage
   *   (daemon-token-usage); forwarded only on a terminal edge, mirroring transcriptRelayError.
   */
  async #advanceTurn(sessionId, status, entity, interruptedReason = null, transcriptRelayError = null, usage = null, backendSessionId = null) {
    try {
      await this.advanceTurn({
        sessionId,
        status,
        entityType: entity?.entityType ?? null,
        entityUuid: entity?.entityUuid ?? null,
        ...(status === "interrupted" && interruptedReason ? { interruptedReason } : {}),
        ...(transcriptRelayError ? { transcriptRelayError } : {}),
        ...(usage ? { usage } : {}),
        ...(backendSessionId ? { backendSessionId } : {}),
      });
    } catch (err) {
      this.logger.warn(
        `[Chorus] advanceTurn failed for session ${sessionId} → ${status}: ${err}`
      );
    }
  }
}

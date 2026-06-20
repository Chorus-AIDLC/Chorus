// cli/waker.mjs
// Executes a single wake: resolve the event to its idea attribution, derive the
// deterministic session id (= the DIRECT idea uuid), build the --mcp-config, spawn
// headless Claude (new vs resume decided by probing the on-disk transcript), and
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

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

export class Waker {
  /**
   * @param {{
   *   creds: { url: string, apiKey: string },
   *   lineage: { resolve: (event: any) => Promise<{ rootIdeaUuid: string|null, directIdeaUuid: string|null }> },
   *   spawner: { wake: (params: any) => Promise<{ sessionId: string, exitCode: number|null, isNew: boolean }> },
   *   cwd?: string,  Spawn working directory; used BOTH for the transcript probe and the spawn (default process.cwd()).
   *   hooks?: import("./upload-hooks.mjs").UploadHooks,
   *   logger?: { info(m:string):void, warn(m:string):void, error(m:string):void },
   *   writeMcpConfigFn?: typeof writeMcpConfig,
   *   isNewSessionFn?: typeof isNewSession,  Injectable for tests (disk probe).
   *   reportInterrupt?: (entityType: string, entityUuid: string, reason: "user"|"crash") => Promise<void>,
   *     Injectable interrupt reporter (子3). Called when a wake's subprocess exits in
   *     an interrupted (user) or crashed (non-zero, no interrupt flag) state. Defaults
   *     to a no-op that logs — the daemon wires the REST reporter (interrupt-reporter.mjs).
   *   advanceTurn?: (params: { sessionId: string, status: "running"|"ended", entityType?: string|null, entityUuid?: string|null }) => Promise<void>,
   *     Injectable turn-lifecycle reporter (子1 — daemon-session-conversation). Called
   *     on spawn (→ running) and on subprocess exit (→ ended) to advance the server-side
   *     DaemonSessionTurn the notification chokepoint created (status `pending`). The
   *     server resolves the turn by the session business key (`sessionId`) and stamps
   *     the weak executionUuid link from entityType/entityUuid. Defaults to a no-op that
   *     logs — the daemon wires the REST reporter (turn-reporter.mjs).
   * }} opts
   */
  constructor(opts) {
    this.creds = opts.creds;
    this.lineage = opts.lineage;
    this.spawner = opts.spawner;
    // The daemon spawns in one fixed working directory; the transcript probe must
    // use the SAME cwd as the spawn, or it would decide new-vs-resume against the
    // wrong directory (claude scopes --resume to cwd).
    this.cwd = opts.cwd ?? process.cwd();
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
    /** @type {Map<string, { entityType: string, entityUuid: string, rootIdeaUuid: string|null, status: "running"|"queued", startedAt: string|null, child: import("node:child_process").ChildProcess|null }>} */
    this.executions = new Map();
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
   * @returns {Array<{ entityType: string, entityUuid: string, rootIdeaUuid: string|null, status: "running"|"queued", startedAt: string|null }>}
   */
  buildExecutionSnapshot() {
    return [...this.executions.values()].map((e) => ({
      entityType: e.entityType,
      entityUuid: e.entityUuid,
      rootIdeaUuid: e.rootIdeaUuid,
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
   * @param {{ rootIdeaUuid?: string|null }} [attribution]  Server-resolved root idea.
   */
  markQueued(notification, key, attribution) {
    const entity = this.#entityOf(notification);
    if (!entity) return;
    const execKey = this.#execKey(entity.entityType, entity.entityUuid);
    const rootIdeaUuid = attribution?.rootIdeaUuid ?? null;
    const existing = this.executions.get(execKey);
    // Don't downgrade a running resource to queued if a duplicate dispatch
    // arrives while it's mid-wake; only (re)mark queued when not already running.
    if (existing && existing.status === "running") return;
    this.executions.set(execKey, {
      entityType: entity.entityType,
      entityUuid: entity.entityUuid,
      rootIdeaUuid,
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
    try {
      const prompt = buildPrompt(notification);
      if (!prompt) {
        this.logger.info(`[Chorus] no wake prompt for action "${notification.action}" — skipping`);
        return;
      }

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
      const isNew = sessionId ? this.isNewSessionFn(sessionId, this.cwd) : true;
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
        cwd: this.cwd,
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

      // No session map to persist anymore — the id is deterministic (= direct idea
      // uuid) and the next wake re-derives new-vs-resume from disk. Just log a
      // non-zero exit visibly (no-silent-errors).
      if (result && result.exitCode !== 0) {
        this.logger.warn(
          `[Chorus] wake for ${key} exited non-zero (${result.exitCode})`
        );
      }

      // Turn lifecycle (子1): the subprocess has exited — advance the server turn
      // running→ended, regardless of exit code (a turn ends whether the run was clean,
      // crashed, or interrupted). Only when it actually reached `running` (a never-
      // spawned wake left the turn `pending`; a pending→ended skip is rejected server-
      // side as invalid_transition). Swallow-safe; never throws into the wake path.
      if (sessionId && turnAdvancedToRunning) {
        await this.#advanceTurn(sessionId, "ended", entity);
      }

      // Interrupt-vs-crash reporting (子3, Tech Design "Interrupt vs crash
      // reporting"). Decide from the per-entity "interrupting" flag the control
      // handler may have set while the subprocess was running:
      //   • interrupting flag set            → interrupted(reason="user")
      //   • no flag AND non-zero/null exit    → interrupted(reason="crash")
      //   • clean exit (code 0)               → nothing (unchanged)
      // The interrupted state is entity-generic — it lives on the DaemonExecution
      // row (keyed connection+entity), so the reporter records it for ANY recognized
      // wake resource (task/idea/proposal/document), not only tasks.
      if (entity && execKey) {
        const wasInterrupting = this.interrupting.has(execKey);
        const cleanExit = result && result.exitCode === 0;
        if (wasInterrupting) {
          await this.#report(entity, "user");
        } else if (!cleanExit) {
          // No interrupt requested but the subprocess did not exit cleanly (non-zero
          // code, or null from a spawn/transport failure) → treat as a crash.
          await this.#report(entity, "crash");
        }
      }

      this.logger.info(
        `[Chorus] wake complete for ${key} (action=${notification.action}, ` +
          `session=${result?.sessionId}, exit=${result?.exitCode})`
      );
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
   * executionUuid link from the live execution row. Never throws into the wake path —
   * a reporter failure is logged and swallowed (the REST reporter already swallows;
   * this is belt-and-braces, matching #report).
   * @param {string} sessionId @param {"running"|"ended"} status
   * @param {{ entityType: string, entityUuid: string }|null} entity
   */
  async #advanceTurn(sessionId, status, entity) {
    try {
      await this.advanceTurn({
        sessionId,
        status,
        entityType: entity?.entityType ?? null,
        entityUuid: entity?.entityUuid ?? null,
      });
    } catch (err) {
      this.logger.warn(
        `[Chorus] advanceTurn failed for session ${sessionId} → ${status}: ${err}`
      );
    }
  }
}

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

    // Per-resource execution registry — the source of truth for the execution
    // snapshot uploaded to the server. Keyed by `${entityType}:${entityUuid}`
    // (the wake-triggering notification's target resource), so a resource appears
    // at most once regardless of how many notifications target it. EVERY wake is
    // tracked — task, idea (@-mention / elaboration under an idea), proposal, and
    // document — not only task dispatches, so the server/UI can show "this daemon
    // is processing <resource>" for any wake. Each entry carries the rootIdeaUuid
    // the waker ALREADY resolved (reused, never re-walked) plus the daemon-side
    // status/startedAt.
    /** @type {Map<string, { entityType: string, entityUuid: string, rootIdeaUuid: string|null, status: "running"|"queued", startedAt: string|null }>} */
    this.executions = new Map();
  }

  /** Recognized wake-triggering resource kinds the server's DaemonExecution accepts. */
  static #EXECUTION_ENTITY_TYPES = new Set(["task", "idea", "proposal", "document"]);

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
      if (entity && execKey) {
        this.executions.set(execKey, {
          entityType: entity.entityType,
          entityUuid: entity.entityUuid,
          rootIdeaUuid,
          status: "running",
          startedAt: new Date().toISOString(),
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
        onMessage: (message) => {
          if (message && typeof message.session_id === "string") observedSessionId = message.session_id;
          // Fire-and-forget transcript hook (no-op in this change).
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

      this.logger.info(
        `[Chorus] wake complete for ${key} (action=${notification.action}, ` +
          `session=${result?.sessionId}, exit=${result?.exitCode})`
      );
    } catch (err) {
      this.logger.warn(`[Chorus] wake failed for ${key}: ${err}`);
    } finally {
      // Wake finished (cleanly or not): the resource leaves the active set. Drop
      // it and emit a fresh snapshot so the server ends its running/queued row.
      // The server reconcile is snapshot-authoritative, so absence == ended.
      if (execKey && this.executions.delete(execKey)) {
        this.#emitExecutionChange();
      }
      try {
        cfg?.cleanup?.();
      } catch {
        // best-effort
      }
    }
  }
}

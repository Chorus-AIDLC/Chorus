// cli/waker.mjs
// Executes a single wake: resolve the event to its root idea, look up / create
// the session, build the --mcp-config, spawn headless Claude, persist the
// session id, and fire the (no-op) upload hooks. The WakeQueue schedules these
// per root idea so two wakes for the same idea never run concurrently.
//
// Module contract (design.md): Waker.wake(notification) → Promise<void>. A
// failure is logged and swallowed — it must never crash the daemon (no-silent-
// errors: visible log, no throw).

import { buildPrompt } from "./prompts.mjs";
import { writeMcpConfig } from "./mcp-config.mjs";

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

export class Waker {
  /**
   * @param {{
   *   creds: { url: string, apiKey: string },
   *   lineage: { rootIdeaFor: (event: any) => Promise<string|null> },
   *   sessionMap: { resolve: (key: string) => { sessionId: string|null, isNew: boolean }, record: (key: string, id: string) => void },
   *   spawner: { wake: (params: any) => Promise<{ sessionId: string, exitCode: number|null, isNew: boolean }> },
   *   hooks?: import("./upload-hooks.mjs").UploadHooks,
   *   logger?: { info(m:string):void, warn(m:string):void, error(m:string):void },
   *   writeMcpConfigFn?: typeof writeMcpConfig,
   * }} opts
   */
  constructor(opts) {
    this.creds = opts.creds;
    this.lineage = opts.lineage;
    this.sessionMap = opts.sessionMap;
    this.spawner = opts.spawner;
    this.hooks = opts.hooks;
    this.logger = opts.logger ?? NOOP_LOGGER;
    this.writeMcpConfigFn = opts.writeMcpConfigFn ?? writeMcpConfig;

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
   * waiting even while it sits behind a same-root wake. The rootIdeaUuid passed here is
   * the one already derived from `key` (idea:<root>) — no extra lineage call.
   * A notification with no reportable resource (missing fields, or an entityType
   * outside the recognized task/idea/proposal/document set) is ignored. Never throws.
   * @param {{ entityType?: string, entityUuid?: string }} notification
   * @param {string} key  The serialization key from keyFor (idea:<root> | entity:…).
   */
  markQueued(notification, key) {
    const entity = this.#entityOf(notification);
    if (!entity) return;
    const execKey = this.#execKey(entity.entityType, entity.entityUuid);
    const rootIdeaUuid = key.startsWith("idea:") ? key.slice("idea:".length) : null;
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
   * Compute the queue key for an event WITHOUT running the wake. Used by the
   * router to enqueue under the right serialization key. Falls back to a
   * per-entity key when there's no idea ancestor (so unrelated entities still
   * get their own serial lane).
   * @param {any} notification
   * @returns {Promise<string>}
   */
  async keyFor(notification) {
    const root = await this.lineage.rootIdeaFor(notification);
    if (root) return `idea:${root}`;
    return `entity:${notification.entityType}:${notification.entityUuid}`;
  }

  /**
   * Run one wake. Never throws.
   * @param {import("./prompts.mjs").NotificationDetail} notification
   * @param {string} key  The serialization key (from keyFor).
   */
  async wake(notification, key) {
    let cfg;
    const entity = this.#entityOf(notification);
    const execKey = entity ? this.#execKey(entity.entityType, entity.entityUuid) : null;
    try {
      const prompt = buildPrompt(notification);
      if (!prompt) {
        this.logger.info(`[Chorus] no wake prompt for action "${notification.action}" — skipping`);
        return;
      }

      // Transition this resource to RUNNING with a start timestamp and emit a
      // fresh snapshot, so the server/UI sees it leave the queue and begin
      // executing. Reuse the rootIdeaUuid already derived from `key` — no extra
      // lineage call.
      if (entity && execKey) {
        const rootIdeaUuid = key.startsWith("idea:") ? key.slice("idea:".length) : null;
        this.executions.set(execKey, {
          entityType: entity.entityType,
          entityUuid: entity.entityUuid,
          rootIdeaUuid,
          status: "running",
          startedAt: new Date().toISOString(),
        });
        this.#emitExecutionChange();
      }

      const { sessionId, isNew } = this.sessionMap.resolve(key);
      cfg = this.writeMcpConfigFn(this.creds);

      await this.hooks?.onSessionStart?.({ rootIdeaKey: key, sessionId: sessionId ?? "", isNew });

      // Track the session id the stream reports so the transcript hook can use
      // it even before spawner.wake() returns. (Do NOT reference the awaited
      // `result` inside onMessage — it's in the temporal dead zone there.)
      let observedSessionId = sessionId ?? "";
      const result = await this.spawner.wake({
        prompt,
        sessionId,
        mcpConfigPath: cfg.path,
        onMessage: (message) => {
          if (message && typeof message.session_id === "string") observedSessionId = message.session_id;
          // Fire-and-forget transcript hook (no-op in this change).
          this.hooks
            ?.onTranscriptMessage?.({ rootIdeaKey: key, sessionId: observedSessionId, message })
            .catch(() => {});
        },
      });

      // Persist the (possibly newly-created) session id so the next wake for
      // this key resumes it — but ONLY on a clean exit. Recording the id after
      // a failed first wake (e.g. claude missing → exitCode null) would make
      // every later wake `--resume` a session that was never created, failing
      // identically forever. On failure we leave the map untouched so the next
      // wake retries as a fresh session. For an already-existing session
      // (isNew=false) the id is already recorded, so re-recording is harmless
      // but we still gate on a clean exit for consistency.
      if (result?.sessionId && result.exitCode === 0) {
        this.sessionMap.record(key, result.sessionId);
      } else if (result && result.exitCode !== 0) {
        this.logger.warn(
          `[Chorus] wake for ${key} exited non-zero (${result.exitCode}); not recording session id`
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

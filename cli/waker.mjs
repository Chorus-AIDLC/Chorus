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
    try {
      const prompt = buildPrompt(notification);
      if (!prompt) {
        this.logger.info(`[Chorus] no wake prompt for action "${notification.action}" — skipping`);
        return;
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
      try {
        cfg?.cleanup?.();
      } catch {
        // best-effort
      }
    }
  }
}

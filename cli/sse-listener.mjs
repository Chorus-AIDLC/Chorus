// cli/sse-listener.mjs
// Subscribes to the Chorus notification SSE stream and feeds parsed events to a
// callback. Plain ESM port of packages/openclaw-plugin/src/sse-listener.ts —
// uses global fetch (Node 18+) so it adds no dependency.
//
// Endpoint: GET /api/events/notifications, Bearer <cho_ key>. Verified against
// src/app/api/events/notifications/route.ts: getAuthContext accepts the Bearer
// API key; data lines are `data: <json>\n\n`, heartbeats are `: ...` comments.

const INITIAL_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

/**
 * @typedef {Object} SseListenerOptions
 * @property {string} url       Chorus base URL.
 * @property {string} apiKey    `cho_` API key.
 * @property {(event: Record<string, unknown>) => void} onEvent
 * @property {() => Promise<void>} [onReconnect]  Called after a reconnect so the
 *   caller can back-fill notifications missed during the gap.
 * @property {{info(m:string):void,warn(m:string):void,error(m:string):void}} [logger]
 * @property {typeof fetch} [fetchImpl]  Injectable for tests.
 * @property {number} [initialDelayMs]
 * @property {number} [maxDelayMs]
 */

export class SseListener {
  /** @param {SseListenerOptions} opts */
  constructor(opts) {
    this.url = opts.url.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.onEvent = opts.onEvent;
    this.onReconnect = opts.onReconnect ?? (async () => {});
    this.logger = opts.logger ?? NOOP_LOGGER;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.initialDelayMs = opts.initialDelayMs ?? INITIAL_DELAY_MS;
    this.maxDelayMs = opts.maxDelayMs ?? MAX_DELAY_MS;

    this.status = "disconnected";
    /** @type {AbortController | null} */
    this.abortController = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.reconnectTimer = null;
    this.reconnectDelay = this.initialDelayMs;
  }

  /** Open the SSE connection. On failure, schedules a backoff reconnect. */
  async connect() {
    this.#clearReconnectTimer();
    const abortController = new AbortController();
    this.abortController = abortController;

    const endpoint = `${this.url}/api/events/notifications`;
    let response;
    try {
      response = await this.fetchImpl(endpoint, {
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "text/event-stream" },
        signal: abortController.signal,
      });
    } catch (err) {
      if (abortController.signal.aborted) return;
      this.logger.error(`[Chorus] SSE connection failed: ${err}`);
      this.#scheduleReconnect();
      return;
    }

    if (!response.ok) {
      this.logger.error(`[Chorus] SSE endpoint returned ${response.status}`);
      this.#scheduleReconnect();
      return;
    }
    if (!response.body) {
      this.logger.error("[Chorus] SSE response has no body");
      this.#scheduleReconnect();
      return;
    }

    const wasReconnect = this.status === "reconnecting";
    this.status = "connected";
    this.reconnectDelay = this.initialDelayMs;
    this.logger.info("[Chorus] SSE connection established");

    if (wasReconnect) {
      try {
        await this.onReconnect();
      } catch (err) {
        this.logger.warn(`[Chorus] onReconnect callback error: ${err}`);
      }
    }

    this.#consumeStream(response.body, abortController.signal);
  }

  /** Gracefully close the connection (no reconnect). */
  disconnect() {
    this.#clearReconnectTimer();
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.status = "disconnected";
    this.logger.info("[Chorus] SSE connection closed");
  }

  /** @param {ReadableStream<Uint8Array>} body @param {AbortSignal} signal */
  async #consumeStream(body, signal) {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done || signal.aborted) break;
        // Strip CR on ingest so CRLF transports (`\r\n\r\n` boundaries) parse the
        // same as LF — the `\n\n` boundary scan below would otherwise never match.
        buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          this.#processMessage(raw);
        }
      }
    } catch (err) {
      if (signal.aborted) return;
      this.logger.warn(`[Chorus] SSE stream error: ${err}`);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
    }
    if (!signal.aborted) {
      this.logger.warn("[Chorus] SSE stream ended, scheduling reconnect");
      this.#scheduleReconnect();
    }
  }

  /** @param {string} raw */
  #processMessage(raw) {
    for (const line of raw.split("\n")) {
      // CR already stripped on ingest. Heartbeat / comment lines start with ":".
      if (line.startsWith(":")) continue;
      if (line.startsWith("data: ")) {
        const jsonStr = line.slice(6);
        try {
          this.onEvent(JSON.parse(jsonStr));
        } catch (err) {
          this.logger.warn(`[Chorus] SSE JSON parse error: ${err} — raw: ${jsonStr}`);
        }
      }
    }
  }

  #scheduleReconnect() {
    this.#clearReconnectTimer();
    this.status = "reconnecting";
    this.logger.info(`[Chorus] SSE reconnecting in ${this.reconnectDelay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxDelayMs);
  }

  #clearReconnectTimer() {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

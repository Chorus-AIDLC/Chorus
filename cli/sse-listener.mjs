// cli/sse-listener.mjs
// Subscribes to the Chorus notification SSE stream and feeds parsed events to a
// callback. Plain ESM port of packages/openclaw-plugin/src/sse-listener.ts —
// uses global fetch (Node 18+) so it adds no dependency.
//
// Endpoint: GET /api/events/notifications, Bearer <cho_ key>. Verified against
// src/app/api/events/notifications/route.ts: getAuthContext accepts the Bearer
// API key; data lines are `data: <json>\n\n`, heartbeats are `: ...` comments.
//
// Self-report: the listener appends ?clientType=claude_code&clientVersion=…&
// host=…&startedAt=… to the endpoint so the server's DaemonConnection registry
// (src/services/daemon-connection.service.ts → parseSelfReport) can record which
// client is on the other end. The CLI reports clientType=claude_code (it only
// drives a local Claude Code subprocess — not a generic "daemon"). These params
// are display-only metadata; auth remains the unchanged Bearer header.

import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const INITIAL_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

// chorus CLI version — read from the package's own package.json (the chorus CLI
// is `@chorus-aidlc/chorus`, whose package.json sits one level above cli/). This
// is the same source `chorus.mjs` uses for `--version`, so the self-reported
// version always matches the installed CLI rather than a hardcoded literal.
// Defensive: fall back to "0.0.0" if the file is unreadable for any reason — a
// missing version must never block the daemon from connecting.
function readCliVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const CLI_VERSION = readCliVersion();

// Daemon process start time, captured once at module load. ISO-8601 string is
// recomputed at URL-construction time from this fixed Date so reconnects report
// the original start, not the reconnect moment.
const PROCESS_STARTED_AT = new Date();

/**
 * @typedef {Object} SseListenerOptions
 * @property {string} url       Chorus base URL.
 * @property {string} apiKey    `cho_` API key.
 * @property {(event: Record<string, unknown>) => void} onEvent
 * @property {(connectionUuid: string) => void} [onConnectionId]  Called once the
 *   server reports which DaemonConnection this stream registered as (the first
 *   `connection_registered` data event). The daemon uses this connectionUuid to
 *   attribute its execution-state snapshots.
 * @property {(event: Record<string, unknown>) => void} [onControl]  Called for a
 *   `type:"control"` data event (the reverse control channel — 子3). This is NOT a
 *   wake: the control event is forked here BEFORE `onEvent`, so the router / WakeQueue
 *   never sees it and it can never spawn a new Claude. The handler verifies the target
 *   connection + entity and interrupts the running subprocess (see control-handler.mjs).
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
    this.onConnectionId = opts.onConnectionId ?? (() => {});
    this.onControl = opts.onControl ?? (() => {});
    this.onReconnect = opts.onReconnect ?? (async () => {});
    /** @type {string|null} The connection this stream registered as (once reported). */
    this.connectionUuid = null;
    this.logger = opts.logger ?? NOOP_LOGGER;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.initialDelayMs = opts.initialDelayMs ?? INITIAL_DELAY_MS;
    this.maxDelayMs = opts.maxDelayMs ?? MAX_DELAY_MS;

    // Build the self-reporting endpoint URL once and reuse it across every
    // (re)connect, so the reconnect path always re-sends the same params.
    const params = new URLSearchParams({
      clientType: "claude_code",
      clientVersion: CLI_VERSION,
      host: hostname(),
      startedAt: PROCESS_STARTED_AT.toISOString(),
    });
    this.endpoint = `${this.url}/api/events/notifications?${params.toString()}`;

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

    let response;
    try {
      response = await this.fetchImpl(this.endpoint, {
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
        let event;
        try {
          event = JSON.parse(jsonStr);
        } catch (err) {
          this.logger.warn(`[Chorus] SSE JSON parse error: ${err} — raw: ${jsonStr}`);
          continue;
        }
        // The server's first data event tells us which DaemonConnection this
        // stream registered as. Capture it (for execution-state attribution) and
        // do NOT forward it as a notification — it isn't one.
        if (event && event.type === "connection_registered" && typeof event.connectionUuid === "string") {
          this.connectionUuid = event.connectionUuid;
          try {
            this.onConnectionId(event.connectionUuid);
          } catch (err) {
            this.logger.warn(`[Chorus] onConnectionId callback error: ${err}`);
          }
          continue;
        }
        // Reverse control channel (子3): a `type:"control"` event is NOT a wake. Fork
        // it to onControl and `continue` — it MUST NEVER fall through to onEvent (the
        // router / WakeQueue), or an interrupt would be mistaken for a wake and could
        // spawn a new Claude. This is the structural guarantee the spec requires.
        if (event && event.type === "control") {
          try {
            this.onControl(event);
          } catch (err) {
            this.logger.warn(`[Chorus] onControl callback error: ${err}`);
          }
          continue;
        }
        this.onEvent(event);
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

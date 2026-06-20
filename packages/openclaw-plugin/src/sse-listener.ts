import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type SseListenerStatus = "connected" | "disconnected" | "reconnecting";

export interface SseNotificationEvent {
  type: string; // "new_notification"
  notificationUuid?: string;
  notificationType?: string; // "task_assigned", "mentioned", etc.
  unreadCount?: number;
  [key: string]: unknown;
}

/**
 * The server's post-handshake `connection_registered` data event (carrying the
 * DaemonConnection uuid this stream registered as). Forked to `onConnectionId`,
 * NEVER to the wake path. See api/events/notifications/route.ts.
 */
export interface SseControlEvent {
  type: string; // "control" | "connection_registered"
  command?: string; // interrupt | resume | deliver_turn (control only)
  connectionUuid?: string; // connection_registered only
  targetConnectionUuid?: string; // control only
  entityType?: string;
  entityUuid?: string;
  turnUuid?: string;
  [key: string]: unknown;
}

export interface ChorusSseListenerOptions {
  chorusUrl: string;
  apiKey: string;
  onEvent: (event: SseNotificationEvent) => void;
  /**
   * Called once the server reports which DaemonConnection this stream registered
   * as (the `connection_registered` data event). Stored as the connection
   * identity (connection-state) and refreshed on every reconnect. This event is
   * NOT a wake — it is forked here BEFORE `onEvent`, so the router never sees it.
   */
  onConnectionId?: (connectionUuid: string) => void;
  /**
   * Called for a `type:"control"` data event (the reverse control channel). This
   * is NOT a wake: the control event is forked here BEFORE `onEvent`, so the
   * router / wake path never sees it and it can never spawn a new embedded-agent
   * run for the control event itself. The handler verifies the target connection
   * (+ entity, for interrupt) and routes to the behavior hooks — see
   * control-handler.ts.
   */
  onControl?: (event: SseControlEvent) => void;
  onReconnect: () => Promise<void>;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

const INITIAL_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

// Plugin version — read from this package's own package.json so the value the
// server's DaemonConnection registry records always matches the installed
// plugin rather than a hardcoded literal. The compiled output lives in dist/
// and the source in src/; both are one level under the package root, so
// "../package.json" resolves to the package manifest in either case. Defensive:
// fall back to "0.0.0" if the manifest is unreadable — a missing version must
// never block the listener from connecting.
function readPluginVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const PLUGIN_VERSION = readPluginVersion();

// Plugin process start time, captured once at module load. Reconnects re-send
// this original start (recomputed to ISO-8601 at URL-construction time), not the
// reconnect moment.
const PROCESS_STARTED_AT = new Date();

export class ChorusSseListener {
  private readonly opts: ChorusSseListenerOptions;
  private readonly onConnectionId: (connectionUuid: string) => void;
  private readonly onControl: (event: SseControlEvent) => void;
  private readonly endpoint: string;
  private _status: SseListenerStatus = "disconnected";
  private abortController: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = INITIAL_DELAY_MS;

  constructor(opts: ChorusSseListenerOptions) {
    this.opts = opts;
    // Default the optional bidirectional callbacks to no-ops so a caller that
    // only wants the wake path (no daemon reporting) still works unchanged.
    this.onConnectionId = opts.onConnectionId ?? (() => {});
    this.onControl = opts.onControl ?? (() => {});

    // Build the self-reporting endpoint URL once and reuse it across every
    // (re)connect, so the reconnect path always re-sends the same params. The
    // CLI reports clientType=openclaw so the server's connection registry can
    // distinguish an OpenClaw daemon from a chorus CLI (claude_code) daemon.
    // These params are display-only metadata; auth remains the Bearer header.
    const params = new URLSearchParams({
      clientType: "openclaw",
      clientVersion: PLUGIN_VERSION,
      host: hostname(),
      startedAt: PROCESS_STARTED_AT.toISOString(),
    });
    this.endpoint = `${this.opts.chorusUrl.replace(/\/$/, "")}/api/events/notifications?${params.toString()}`;
  }

  get status(): SseListenerStatus {
    return this._status;
  }

  /** Start the SSE connection. Resolves once the first bytes arrive (or rejects on immediate failure). */
  async connect(): Promise<void> {
    this.clearReconnectTimer();

    const abortController = new AbortController();
    this.abortController = abortController;

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          Accept: "text/event-stream",
        },
        signal: abortController.signal,
      });
    } catch (err) {
      if (abortController.signal.aborted) return; // intentional disconnect
      this.opts.logger.error(`SSE connection failed: ${err}`);
      this.scheduleReconnect();
      return;
    }

    if (!response.ok) {
      this.opts.logger.error(`SSE endpoint returned ${response.status}`);
      this.scheduleReconnect();
      return;
    }

    if (!response.body) {
      this.opts.logger.error("SSE response has no body");
      this.scheduleReconnect();
      return;
    }

    // Connection succeeded — reset backoff
    const isReconnect = this._status === "reconnecting";
    this._status = "connected";
    this.reconnectDelay = INITIAL_DELAY_MS;
    this.opts.logger.info("[Chorus] SSE connection established");

    if (isReconnect) {
      // Fire onReconnect callback so the caller can back-fill missed notifications
      try {
        await this.opts.onReconnect();
      } catch (err) {
        this.opts.logger.warn(`onReconnect callback error: ${err}`);
      }
    }

    // Read the stream
    this.consumeStream(response.body, abortController.signal);
  }

  /** Gracefully close the SSE connection. */
  disconnect(): void {
    this.clearReconnectTimer();
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this._status = "disconnected";
    this.opts.logger.info("SSE connection closed");
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async consumeStream(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done || signal.aborted) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE messages are delimited by double newlines
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          this.processMessage(raw);
        }
      }
    } catch (err) {
      if (signal.aborted) return; // intentional disconnect
      this.opts.logger.warn(`SSE stream error: ${err}`);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
    }

    // Stream ended unexpectedly — reconnect unless we were intentionally disconnected
    if (!signal.aborted) {
      this.opts.logger.warn("SSE stream ended, scheduling reconnect");
      this.scheduleReconnect();
    }
  }

  private processMessage(raw: string): void {
    for (const line of raw.split("\n")) {
      // Comment lines (heartbeats) — ignore
      if (line.startsWith(":")) continue;

      // Data lines
      if (line.startsWith("data: ")) {
        const jsonStr = line.slice(6);
        let event: SseNotificationEvent;
        try {
          event = JSON.parse(jsonStr);
        } catch (err) {
          this.opts.logger.warn(`SSE JSON parse error: ${err} — raw: ${jsonStr}`);
          continue;
        }

        // The server's post-handshake `connection_registered` data event tells us
        // which DaemonConnection this stream registered as. Capture it (the
        // connection identity used to attribute reports + double-check control
        // commands) and do NOT forward it to the wake path — it isn't a
        // notification. Forked here so the router never logs it as ignored.
        if (event.type === "connection_registered" && typeof event.connectionUuid === "string") {
          try {
            this.onConnectionId(event.connectionUuid);
          } catch (err) {
            this.opts.logger.warn(`onConnectionId callback error: ${err}`);
          }
          continue;
        }

        // Reverse control channel: a `type:"control"` event is NOT a wake. Fork it
        // to onControl and `continue` — it MUST NEVER fall through to onEvent (the
        // router / wake path), or a control command could be mistaken for a wake and
        // spawn a new embedded-agent run. This is the structural guarantee the spec
        // requires.
        if (event.type === "control") {
          try {
            this.onControl(event as SseControlEvent);
          } catch (err) {
            this.opts.logger.warn(`onControl callback error: ${err}`);
          }
          continue;
        }

        this.opts.onEvent(event);
      }
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this._status = "reconnecting";

    this.opts.logger.info(`SSE reconnecting in ${this.reconnectDelay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);

    // Exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_DELAY_MS);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

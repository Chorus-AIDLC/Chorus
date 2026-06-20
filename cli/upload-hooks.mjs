// cli/upload-hooks.mjs
// Execution-state upload hook for the daemon's observability layer
// (daemon-execution-state spec, design.md "Implementation Plan" step 3).
//
// The daemon already knows, in process memory, which tasks it is running and
// which are queued (the WakeQueue's scheduling state, joined with the waker's
// per-task lineage map). This module turns that into the snapshot the server's
// ingest endpoint expects and POSTs it:
//
//   POST /api/daemon/execution-state
//   { connectionUuid, executions: [{ taskUuid, rootIdeaUuid|null, status, startedAt|null }] }
//
// Reuses global fetch (Node 18+) and the daemon's existing Bearer credentials —
// exactly like lineage.mjs / sse-listener.mjs — so it adds ZERO new dependency
// (CLAUDE.md pitfall #9), no shell-out, no platform-specific paths. The POST is
// fire-and-forget: it never blocks or breaks the wake path, and a failed upload
// is LOGGED (no silent errors) and non-fatal — it never throws to the caller.
//
// `status` is constrained to "running"/"queued"; "ended" is a server-only
// terminal state the daemon never reports (the server rejects it).
//
// Transport: both the transcript POST and the execution-state POST go through the SHARED
// daemon REST client (`cli/daemon-rest-client.mjs`), which owns the request, Bearer auth,
// and the no-silent-errors transport contract. These hooks keep only the host-side
// concerns the client does not own — batching/debounce + content extraction for the
// transcript, and the snapshot build + serialized fire-and-forget chaining for both.

import { createDaemonRestClient } from "./daemon-rest-client.mjs";

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

/**
 * @typedef {Object} SnapshotExecution
 * @property {string} taskUuid
 * @property {string|null} [rootIdeaUuid]   null for a task with no root-idea lineage.
 * @property {"running"|"queued"} status
 * @property {string|null} [startedAt]      ISO-8601; null while merely queued.
 */

/**
 * @typedef {Object} UploadHooks
 * @property {(info: { host: string, agentUuid?: string }) => Promise<void>} onConnect
 * @property {(info: { rootIdeaKey: string, sessionId: string, isNew: boolean }) => Promise<void>} onSessionStart
 * @property {(info: { rootIdeaKey: string, sessionId: string, message: any }) => Promise<void>} onTranscriptMessage
 * @property {() => void} [onExecutionChange]  Fire-and-forget: upload a fresh
 *   execution snapshot. The waker calls this on every lifecycle transition
 *   (enqueue / wake start / wake finish). No-op in the noop hooks.
 */

/**
 * The default no-op hooks. Each resolves immediately and does nothing — no
 * network, no disk. Used in tests and as a safe default where execution upload
 * is not wired (e.g. the daemon could not learn its connectionUuid).
 * @returns {UploadHooks}
 */
export function createNoopUploadHooks() {
  return {
    async onConnect() {},
    async onSessionStart() {},
    async onTranscriptMessage() {},
    onExecutionChange() {},
  };
}

/**
 * Compose several `UploadHooks` into one. The waker takes a SINGLE hooks object, but
 * the daemon now has two independent concerns — execution-state snapshots and
 * transcript relay — each built by its own factory. This merges them so each named
 * hook fans out to every set that defines it: `onSessionStart`/`onTranscriptMessage`
 * route to the transcript hooks, `onExecutionChange` to the execution hooks, etc. Async
 * hooks are awaited (all in parallel); the synchronous `onExecutionChange` is called
 * directly. Each delegate is invoked inside its own try/catch so one set throwing can
 * never break another or the wake path (warn-not-throw).
 *
 * @param {...(UploadHooks|undefined|null)} hookSets
 * @param {{ logger?: { warn(m:string):void } }} [optsLast]  Last arg may be an options
 *   object (logger). Distinguished from a hook set by the absence of hook methods.
 * @returns {UploadHooks}
 */
export function mergeUploadHooks(...args) {
  // Allow an optional trailing `{ logger }` options object.
  let logger = NOOP_LOGGER;
  const sets = [];
  for (const a of args) {
    if (!a) continue;
    const looksLikeHooks =
      typeof a.onConnect === "function" ||
      typeof a.onSessionStart === "function" ||
      typeof a.onTranscriptMessage === "function" ||
      typeof a.onExecutionChange === "function";
    if (!looksLikeHooks && a.logger) {
      logger = a.logger;
      continue;
    }
    sets.push(a);
  }

  async function fanOutAsync(name, info) {
    await Promise.all(
      sets.map(async (s) => {
        const fn = s[name];
        if (typeof fn !== "function") return;
        try {
          await fn.call(s, info);
        } catch (err) {
          logger.warn(`[Chorus] ${name} hook failed: ${err}`);
        }
      })
    );
  }

  return {
    onConnect: (info) => fanOutAsync("onConnect", info),
    onSessionStart: (info) => fanOutAsync("onSessionStart", info),
    onTranscriptMessage: (info) => fanOutAsync("onTranscriptMessage", info),
    onExecutionChange: () => {
      for (const s of sets) {
        if (typeof s.onExecutionChange !== "function") continue;
        try {
          s.onExecutionChange();
        } catch (err) {
          logger.warn(`[Chorus] onExecutionChange hook failed: ${err}`);
        }
      }
    },
  };
}

// ─── Transcript upload (子1 — daemon-session-conversation) ──────────────────
//
// The daemon's stream-json consumer (claude-spawner → waker.onMessage) hands every
// NDJSON object to `onTranscriptMessage`. Claude Code's stream-json (verified against
// CLI 2.1.183) wraps each conversation message as:
//
//   { "type": "assistant" | "user", "session_id": "...",
//     "message": { "role": "assistant" | "user",
//                  "content": [ { "type": "text", "text": "..." },
//                               { "type": "thinking", ... },
//                               { "type": "tool_use", ... },
//                               { "type": "tool_result", ... } ] } }
//
// `system` (init / hooks / thinking_tokens) and `result` envelopes are NOT
// conversation messages. A `tool_result` block rides inside a `type:"user"` message,
// so filtering MUST happen at the content-BLOCK level (keep only `text`), not at the
// top-level type — otherwise a tool-result-only user message would leak. The server
// ingest stores ONLY `user`/`assistant` text (see /api/daemon/transcript), so this
// filter mirrors exactly what the server will persist.

/** Top-level stream-json envelope types that carry a conversation message. */
const CONVERSATION_TYPES = new Set(["user", "assistant"]);

/**
 * Extract the plain user/assistant TEXT from one Claude Code stream-json object,
 * dropping everything that is not a conversation text block (system/result
 * envelopes, thinking, tool_use, tool_result). Returns null when the object is not a
 * keepable conversation message (so the caller can skip it). Never throws — a shape
 * it doesn't recognize yields null rather than an error (defensive against CLI drift).
 *
 * @param {any} obj  One parsed stream-json NDJSON object.
 * @returns {{ role: "user"|"assistant", text: string } | null}
 */
export function extractTranscriptText(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (!CONVERSATION_TYPES.has(obj.type)) return null;

  const message = obj.message;
  if (!message || typeof message !== "object") return null;
  // The persisted role is the message's role; fall back to the envelope type (they
  // agree in practice, but the envelope is the documented discriminator).
  const role = message.role === "user" || message.role === "assistant" ? message.role : obj.type;
  if (role !== "user" && role !== "assistant") return null;

  const content = message.content;
  let text = "";
  if (typeof content === "string") {
    // Some message variants carry a bare string (e.g. an echoed initial prompt).
    text = content;
  } else if (Array.isArray(content)) {
    // Keep ONLY `text` blocks — drop thinking / tool_use / tool_result. Concatenate
    // the text blocks of one message into a single transcript entry (mirrors how a
    // reader sees the message; the server stores one row per posted message).
    const parts = [];
    for (const block of content) {
      if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    text = parts.join("");
  } else {
    return null;
  }

  // A message with no text (e.g. a user message that was purely a tool_result, or an
  // assistant message that was purely tool_use/thinking) is dropped — nothing to store.
  if (!text.trim()) return null;
  return { role, text };
}

/**
 * Build the transcript upload hooks (子1). The daemon's stream-json consumer calls
 * `onTranscriptMessage` for every NDJSON object; this keeps only user/assistant text
 * and batch-POSTs it to `POST /api/daemon/transcript`, targeting the current turn by
 * the session BUSINESS KEY (`sessionId` = directIdeaUuid or the entity uuid — exactly
 * what the waker anchors the Claude session on, and what turn-reporter advances). The
 * server resolves the agent's `(agentUuid, sessionId)` session and appends to its
 * most-recent turn. `onSessionStart` resets per-session batching state so a new run's
 * messages attach to the right turn.
 *
 * Mirrors `createExecutionUploadHooks`: injectable `fetchImpl`, the daemon's existing
 * Bearer creds, ZERO new deps (global fetch, Node 18+). Fire-and-forget + warn-not-throw:
 * a failed upload is LOGGED (no-silent-errors) and never blocks/breaks the wake. Uploads
 * are batched (debounced) so a burst of stream-json lines becomes few POSTs, and
 * serialized on a chain so an earlier batch can't land after a later one.
 *
 * @param {{
 *   url: string,                  Chorus base URL.
 *   apiKey: string,               `cho_` agent API key.
 *   logger?: { info(m:string):void, warn(m:string):void, error(m:string):void },
 *   fetchImpl?: typeof fetch,     Injectable for tests.
 *   batchDelayMs?: number,        Debounce window for coalescing messages into one POST
 *                                 (default 50ms). 0 → flush on the next microtask.
 *   setTimeoutImpl?: typeof setTimeout,  Injectable timer for tests.
 *   clearTimeoutImpl?: typeof clearTimeout,
 * }} opts
 * @returns {UploadHooks}
 */
export function createTranscriptUploadHooks(opts) {
  const logger = opts.logger ?? NOOP_LOGGER;
  const batchDelayMs = opts.batchDelayMs ?? 50;
  const setTimeoutImpl = opts.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = opts.clearTimeoutImpl ?? clearTimeout;
  // Transport via the shared client (transcript has no connectionUuid concern — the agent
  // key + sessionId resolve the turn server-side, so getConnectionUuid is unused here).
  const client = createDaemonRestClient({
    url: opts.url,
    apiKey: opts.apiKey,
    fetchImpl: opts.fetchImpl,
    logger,
  });

  // The session this batch belongs to (set by onSessionStart, and re-affirmed by each
  // message's observed session id from the stream). Messages queued for one session
  // are flushed before the session changes, so they always target the right turn.
  let currentSessionId = null;
  /** @type {Array<{ role: "user"|"assistant", text: string }>} */
  let pending = [];
  let timer = null;
  // Serialize POSTs so an earlier batch can never land after a later one on the wire.
  let chain = Promise.resolve();

  /** POST one batch for a session via the shared client. Never throws. */
  async function upload(sessionId, messages) {
    if (!sessionId || messages.length === 0) return;
    // The client POSTs `{ sessionId, messages }` to /api/daemon/transcript with Bearer
    // auth and logs "transcript upload request failed" / "transcript upload returned N"
    // on failure (no-silent-errors) and "transcript uploaded (N msg) ..." on success. We
    // swallow the structured result so a failed upload never breaks the wake path.
    await client.transcript({ sessionId, messages });
  }

  /** Drain `pending` for `currentSessionId` into a serialized fire-and-forget POST. */
  function flush() {
    if (timer !== null) {
      clearTimeoutImpl(timer);
      timer = null;
    }
    if (pending.length === 0) return;
    const sessionId = currentSessionId;
    const batch = pending;
    pending = [];
    if (!sessionId) {
      // No session to attribute the messages to (onSessionStart never ran / no id on
      // the stream). Drop with a visible warning rather than mis-route (no-silent).
      logger.warn(`[Chorus] dropping ${batch.length} transcript msg — no session id yet`);
      return;
    }
    const run = () => upload(sessionId, batch);
    chain = chain.then(run, run);
  }

  function scheduleFlush() {
    if (timer !== null) return;
    if (batchDelayMs <= 0) {
      // Microtask flush — coalesces a synchronous burst, still off the hot path.
      timer = setTimeoutImpl(flush, 0);
    } else {
      timer = setTimeoutImpl(flush, batchDelayMs);
    }
  }

  return {
    async onConnect() {},
    /**
     * A new (or resumed) Claude run started for this session. Flush any leftover
     * messages from a prior session, then pin the batch to this session id so
     * subsequent messages attach to the right turn. (子1 — onSessionStart contract.)
     * @param {{ rootIdeaKey: string, sessionId: string, isNew: boolean }} info
     */
    async onSessionStart({ sessionId } = {}) {
      // If the session changed mid-stream, flush the old session's pending batch first
      // so its messages don't get re-tagged to the new session.
      if (currentSessionId && currentSessionId !== sessionId) flush();
      currentSessionId = sessionId || currentSessionId || null;
    },
    /**
     * One stream-json object. Keep only user/assistant text; queue it for a batched
     * POST. Fire-and-forget + non-throwing: any failure is logged inside `flush`/`upload`.
     * @param {{ rootIdeaKey: string, sessionId: string, message: any }} info
     */
    async onTranscriptMessage({ sessionId, message } = {}) {
      // The stream stamps the authoritative session id on every line; prefer it so a
      // session resolved only from the stream (not onSessionStart) is still attributed.
      if (sessionId) currentSessionId = sessionId;
      let extracted;
      try {
        extracted = extractTranscriptText(message);
      } catch (err) {
        logger.warn(`[Chorus] transcript extract failed: ${err}`);
        return;
      }
      if (!extracted) return; // not a keepable conversation text message
      pending.push(extracted);
      scheduleFlush();
    },
    onExecutionChange() {},
  };
}

/**
 * Build the execution-state upload hooks. The returned `onExecutionChange()` is
 * synchronous and non-throwing: it kicks off a fire-and-forget POST and returns
 * immediately, so the wake path is never blocked. The transcript/session/connect
 * hooks remain no-ops (reserved for a later observability slice).
 *
 * @param {{
 *   url: string,                         Chorus base URL.
 *   apiKey: string,                      `cho_` agent API key.
 *   getConnectionUuid: () => (string|null),  The connection this daemon registered
 *                                            as (null until the SSE handshake
 *                                            reports it — uploads are skipped while null).
 *   getSnapshot: () => SnapshotExecution[],  Builds the current snapshot from live
 *                                            daemon state (WakeQueue + waker lineage map).
 *   logger?: { info(m:string):void, warn(m:string):void, error(m:string):void },
 *   fetchImpl?: typeof fetch,            Injectable for tests.
 * }} opts
 * @returns {UploadHooks}
 */
export function createExecutionUploadHooks(opts) {
  const getSnapshot = opts.getSnapshot;
  const logger = opts.logger ?? NOOP_LOGGER;
  // Transport via the shared client. It owns the connectionUuid guard (silent skip while
  // the SSE handshake hasn't reported it — a normal early state, not an error), the
  // request, Bearer auth, and the failure logging ("execution-state upload request failed"
  // / "execution-state upload returned N") + success log.
  const client = createDaemonRestClient({
    url: opts.url,
    apiKey: opts.apiKey,
    getConnectionUuid: opts.getConnectionUuid,
    fetchImpl: opts.fetchImpl,
    logger,
  });

  // Serialize uploads so two rapid transitions can't reorder on the wire (a
  // later snapshot must not land before an earlier one). The snapshot is
  // captured SYNCHRONOUSLY at emit time (not re-read at send time): each
  // lifecycle transition's state is preserved even when transitions happen
  // faster than uploads flush — so a brief "running" state is never silently
  // collapsed into the subsequent "finished" upload.
  let chain = Promise.resolve();

  /** POST a captured snapshot via the shared client. Never throws. */
  async function upload(executions) {
    await client.executionState({ executions });
  }

  return {
    async onConnect() {},
    async onSessionStart() {},
    async onTranscriptMessage() {},
    /**
     * Fire-and-forget upload of the current snapshot. Synchronous + non-throwing
     * so it never blocks/breaks the wake path. The snapshot is captured here, at
     * call time, then queued behind any in-flight upload; failures are logged
     * inside `upload()`. A snapshot-build error is logged and skips the POST.
     */
    onExecutionChange() {
      let executions;
      try {
        executions = getSnapshot();
      } catch (err) {
        logger.warn(`[Chorus] execution snapshot build failed: ${err}`);
        return;
      }
      // Chain on both fulfill and reject so one failed upload can't wedge the
      // chain; `upload` already swallows its own errors, this is belt-and-braces.
      const run = () => upload(executions);
      chain = chain.then(run, run);
    },
  };
}

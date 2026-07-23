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
 * @property {(info: { sessionId: string }) => Promise<{ relayError: string|null }>} [onSessionEnd]
 *   Fire-and-forget + await-able: the wake's subprocess has exited. FLUSH any buffered
 *   (debounced) transcript for the session NOW and await it, so a turn's trailing
 *   user/assistant text is persisted BEFORE the waker advances the turn to a terminal
 *   status (fix #444 — transcript-relay flush-on-exit). Best-effort + non-throwing.
 *   RETURNS `{ relayError }`: the final terminal upload failure reason for this session
 *   (retry exhausted / non-2xx / network) when the reply was produced but never reached
 *   Chorus, else `null` (a later success clears it). The waker forwards this onto the
 *   exit-path turn-advance so the UI can say "reply couldn't be uploaded (reason)" rather
 *   than the misleading "no reply received". No-op (`{ relayError: null }`) in the noop
 *   hooks and in the execution-only hooks.
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
    async onSessionEnd() {
      return { relayError: null };
    },
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
      typeof a.onSessionEnd === "function" ||
      typeof a.onExecutionChange === "function";
    if (!looksLikeHooks && a.logger) {
      logger = a.logger;
      continue;
    }
    sets.push(a);
  }

  async function fanOutAsync(name, info) {
    const results = await Promise.all(
      sets.map(async (s) => {
        const fn = s[name];
        if (typeof fn !== "function") return undefined;
        try {
          return await fn.call(s, info);
        } catch (err) {
          logger.warn(`[Chorus] ${name} hook failed: ${err}`);
          return undefined;
        }
      })
    );
    return results;
  }

  return {
    // The void-returning hooks discard the internal results array (they resolve to
    // `undefined`, matching the single-hook contract — nothing downstream reads them).
    onConnect: async (info) => {
      await fanOutAsync("onConnect", info);
    },
    onSessionStart: async (info) => {
      await fanOutAsync("onSessionStart", info);
    },
    onTranscriptMessage: async (info) => {
      await fanOutAsync("onTranscriptMessage", info);
    },
    // Fan out to every set, then AGGREGATE the transcript relay outcome: the first
    // set that reports a non-null `relayError` wins (only the transcript hook produces
    // one; others resolve `{ relayError: null }` or undefined). The waker forwards this
    // onto the exit-path turn-advance (fix #444 follow-up — surface a KNOWN relay drop).
    onSessionEnd: async (info) => {
      const results = await fanOutAsync("onSessionEnd", info);
      const relayError =
        results.find((r) => r && r.relayError)?.relayError ?? null;
      return { relayError };
    },
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
//
// Harness-injected synthetic content: when the model loads a skill, the skill's full
// markdown body is delivered as a SYNTHETIC user turn. On the live stream-json stdout
// (verified against Claude Code CLI 2.1.195 by capturing real `claude -p
// --output-format stream-json --verbose` output) that envelope is
// `{ type:"user", isSynthetic:true, message:{ content:[{type:"text", text:"Base
// directory for this skill: …"}] } }`. Because it's a plain `text` block, the
// block-level filter alone would KEEP it and leak the whole skill body to Chorus, so
// we drop `type:"user"` envelopes flagged `isSynthetic:true` outright. ⚠️ FIELD NAME:
// the live stream marks this `isSynthetic`; the on-disk transcript JSONL
// (~/.claude/projects/.../*.jsonl, which the daemon does NOT read) marks the SAME
// message `isMeta` — keying on `isMeta` here would be a silent no-op. Genuine human
// instructions and the agent's own replies never carry `isSynthetic`, so this is a
// purely structural match (no size/content heuristic) and cannot drop real content.
// MCP-server instructions, CLAUDE.md context, and the deferred-tool listing are folded
// into the dropped `type:"system"` init envelope and never reach this filter. Scope is
// the Claude Code dialect only — the codex (`item.completed`) path is unaffected.

/** Top-level stream-json envelope types that carry a conversation message. */
const CONVERSATION_TYPES = new Set(["user", "assistant"]);

/**
 * Remove `<system-reminder>…</system-reminder>` spans from a retained text block
 * (defense-in-depth for harness-injected reminders that ride inside a kept text
 * block). Structural tag match — not a size/content heuristic. Non-reminder text is
 * left untouched; a message that is only a reminder collapses to empty and is then
 * dropped by the caller's emptiness check.
 * @param {string} s
 * @returns {string}
 */
function stripSystemReminders(s) {
  return s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
}

/**
 * Extract the plain user/assistant TEXT from one stream object emitted by EITHER
 * backend's headless stream, dropping everything that is not a conversation text
 * block. Returns null when the object is not a keepable conversation message (so
 * the caller can skip it). Never throws — a shape it doesn't recognize yields null
 * rather than an error (defensive against CLI drift).
 *
 * Two stream dialects are recognized (their top-level shapes are disjoint, so no
 * backend flag is needed):
 *  - Claude Code stream-json: `{ type: "user"|"assistant", message: { content … } }`.
 *  - codex `codex exec --json`: conversation/tool output rides on `item.completed`
 *    events discriminated by `item.type`; assistant text is an `agent_message`
 *    item with a top-level `item.text` (verified against codex-cli 0.142.3). codex
 *    does NOT echo the user prompt (the chat UI renders that from the turn's
 *    promptText), and `reasoning` / `command_execution` / lifecycle envelopes are
 *    not conversation text — all dropped.
 *
 * @param {any} obj  One parsed stream NDJSON object.
 * @returns {{ role: "user"|"assistant", text: string } | null}
 */
export function extractTranscriptText(obj) {
  if (!obj || typeof obj !== "object") return null;

  // ── codex `codex exec --json` dialect ──
  // Only `item.completed` carries finished output; an `agent_message` item is the
  // assistant's conversation text. Everything else (reasoning, command_execution,
  // file_change, thread.started/turn.* lifecycle) is not user/assistant text.
  if (obj.type === "item.completed") {
    const item = obj.item;
    if (!item || typeof item !== "object" || item.type !== "agent_message") return null;
    const itemText = typeof item.text === "string" ? item.text : "";
    if (!itemText.trim()) return null;
    return { role: "assistant", text: itemText };
  }

  // ── Claude Code stream-json dialect ──
  if (!CONVERSATION_TYPES.has(obj.type)) return null;

  // Drop harness-injected synthetic content (e.g. a loaded skill body). Claude Code
  // marks these user turns `isSynthetic:true` on the live stream (NOT the on-disk
  // `isMeta` field). Gated on `type:"user"` so a synthetic *assistant* envelope, if one
  // ever appears, is still treated as real assistant text. Structural match only.
  if (obj.type === "user" && obj.isSynthetic === true) return null;

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

  // Strip any wrapped <system-reminder> spans (defense-in-depth) before deciding
  // emptiness, so a reminder-only message collapses to nothing and is dropped.
  text = stripSystemReminders(text);

  // A message with no text (e.g. a user message that was purely a tool_result, an
  // assistant message that was purely tool_use/thinking, or text that was only a
  // system-reminder) is dropped — nothing to store.
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
 *   maxUploadAttempts?: number,   Bounded retry for a failed transcript POST (transient
 *                                 network error / non-2xx). Total attempts including the
 *                                 first (default 3). ≤1 disables retry. fix #444 — a
 *                                 transient Docker-proxy 502 must not silently drop a turn's
 *                                 transcript.
 *   retryBackoffMs?: number,      Base backoff between attempts (default 200ms); the Nth
 *                                 retry waits `retryBackoffMs * N`.
 *   sleepImpl?: (ms: number) => Promise<void>,  Injectable backoff sleep for tests (default
 *                                 a real setTimeout-based delay).
 * }} opts
 * @returns {UploadHooks}
 */
export function createTranscriptUploadHooks(opts) {
  const logger = opts.logger ?? NOOP_LOGGER;
  const batchDelayMs = opts.batchDelayMs ?? 50;
  const setTimeoutImpl = opts.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = opts.clearTimeoutImpl ?? clearTimeout;
  // Bounded retry for a failed transcript POST (fix #444 — no more silent drops on a
  // transient non-2xx / network blip). Retry lives HERE, in the host-side hook, NOT in
  // the shared daemon-rest-client (which stays a single-shot transport by contract).
  const maxUploadAttempts = Math.max(1, opts.maxUploadAttempts ?? 3);
  const retryBackoffMs = opts.retryBackoffMs ?? 200;
  const sleepImpl =
    opts.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeoutImpl(resolve, ms)));
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
  // The final upload failure reason for the CURRENT session's most recent batch, or null
  // when the last upload succeeded/was skipped (fix #444 follow-up). `onSessionEnd`
  // returns this so the waker can annotate the terminal turn with WHY its transcript is
  // missing. Reset per session in `onSessionStart`; set only when a batch exhausts its
  // retry budget (a transient failure that a later batch recovers is NOT surfaced).
  let lastRelayError = null;

  /**
   * POST one batch for a session via the shared client, with bounded retry. Never throws.
   *
   * The client POSTs `{ sessionId, messages }` to /api/daemon/transcript with Bearer auth
   * and returns a structured `{ ok }` result (it logs its own request-failed / non-2xx /
   * success lines). A transient failure (`ok === false`) is retried up to
   * `maxUploadAttempts` total with an increasing backoff; on the final failure the batch
   * is dropped with ONE loud warn naming the lost message count (fix #444 — a Docker-proxy
   * 502 previously dropped the turn's transcript silently on the first try). A `skipped`
   * result (empty batch / no session) is a success no-op, never retried.
   */
  async function upload(sessionId, messages) {
    if (!sessionId || messages.length === 0) return;
    for (let attempt = 1; attempt <= maxUploadAttempts; attempt += 1) {
      const result = await client.transcript({ sessionId, messages });
      // ok (2xx) or an intentional skip → done. A success CLEARS any prior relay error
      // (a transient failure that a later batch recovered must not be surfaced as a drop).
      if (!result || result.ok || result.skipped) {
        lastRelayError = null;
        return;
      }
      if (attempt < maxUploadAttempts) {
        // Wait then retry — the client already logged the failure cause for this attempt.
        await sleepImpl(retryBackoffMs * attempt);
        continue;
      }
      // Exhausted the budget: drop LOUDLY (no silent errors), naming what was lost, AND
      // record the reason so `onSessionEnd` can surface it on the turn (fix #444 follow-up).
      // Prefer the client's structured `error` (e.g. "transcript upload returned 502");
      // fall back to a generic phrasing so the field is never an empty string.
      lastRelayError =
        result.error ?? `transcript upload failed for session ${sessionId}`;
      logger.warn(
        `[Chorus] transcript upload gave up after ${maxUploadAttempts} attempt(s) — ` +
          `dropping ${messages.length} message(s) for session ${sessionId}`,
      );
    }
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
      // Fresh wake → clear any relay error carried from a prior session's uploads so it
      // can't leak onto this turn (fix #444 follow-up).
      lastRelayError = null;
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
    /**
     * The wake's subprocess has exited (fix #444 — flush-on-exit). Cancel the debounce
     * timer, drain the buffered batch onto the serialized chain NOW, and AWAIT the chain
     * so the trailing transcript is persisted BEFORE the waker advances the turn to a
     * terminal status. Awaiting matters: the server attaches transcript to the session's
     * `running` turn, so the flush must land while the turn is still `running`. Best-effort
     * + non-throwing — a flush failure is already logged inside `upload`, and we swallow
     * anything else so a flush error never crashes the wake exit path.
     *
     * `sessionId` (from the caller — the waker's session anchor) re-affirms the batch's
     * attribution in case no stream line ever set `currentSessionId` (e.g. a run that
     * produced only a trailing message right before exit).
     *
     * Returns `{ relayError }`: the final terminal upload failure reason (retry exhausted)
     * after the flush settles, or null when every batch landed. The waker forwards it onto
     * the exit-path turn-advance so a KNOWN relay drop is surfaced on the turn (fix #444
     * follow-up) rather than misread as "no reply received".
     * @param {{ sessionId?: string }} info
     * @returns {Promise<{ relayError: string|null }>}
     */
    async onSessionEnd({ sessionId } = {}) {
      if (sessionId) currentSessionId = sessionId;
      try {
        flush();
        // Await the serialized chain so all queued POSTs (this batch + any still in flight)
        // settle before we return. `chain` never rejects (upload swallows), but guard anyway.
        await chain;
      } catch (err) {
        logger.warn(`[Chorus] transcript flush on session end failed: ${err}`);
      }
      // `lastRelayError` reflects the outcome of the FINAL batch's upload (set on retry
      // exhaustion, cleared on success) — read it AFTER the chain settles.
      return { relayError: lastRelayError };
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

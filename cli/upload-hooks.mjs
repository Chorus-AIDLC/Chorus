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
 * @property {(info: { sessionId: string }) => Promise<{ relayError: string|null, usage: TokenUsage|null }>} [onSessionEnd]
 *   Fire-and-forget + await-able: the wake's subprocess has exited. FLUSH any buffered
 *   (debounced) transcript for the session NOW and await it, so a turn's trailing
 *   user/assistant text is persisted BEFORE the waker advances the turn to a terminal
 *   status (fix #444 — transcript-relay flush-on-exit). Best-effort + non-throwing.
 *   RETURNS `{ relayError, usage }`:
 *     • `relayError` — the final terminal upload failure reason for this session (retry
 *       exhausted / non-2xx / network) when the reply was produced but never reached
 *       Chorus, else `null` (a later success clears it). The waker forwards it onto the
 *       exit-path turn-advance so the UI can say "reply couldn't be uploaded (reason)"
 *       rather than the misleading "no reply received".
 *     • `usage` — the turn's authoritative per-turn {@link TokenUsage} (daemon-token-usage),
 *       or `null` when the run emitted no `result` frame. The waker forwards it onto the
 *       same terminal turn-advance so the server persists it.
 *   No-op (`{ relayError: null, usage: null }`) in the noop hooks and the execution-only hooks.
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
      return { relayError: null, usage: null };
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
    // Fan out to every set, then AGGREGATE the transcript relay outcome + the token usage:
    // the first set that reports a non-null `relayError` wins, and independently the first
    // that reports a non-null `usage` wins (only the transcript hook produces either; others
    // resolve nulls or undefined). The waker forwards BOTH onto the exit-path turn-advance
    // (fix #444 relay drop + daemon-token-usage). Aggregated independently so one being null
    // never suppresses the other.
    onSessionEnd: async (info) => {
      const results = await fanOutAsync("onSessionEnd", info);
      const relayError =
        results.find((r) => r && r.relayError)?.relayError ?? null;
      const usage = results.find((r) => r && r.usage)?.usage ?? null;
      return { relayError, usage };
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

// ─── Per-turn token usage capture (daemon-token-usage) ──────────────────────
//
// The normalized token-usage shape carried end-to-end — the SINGLE contract every
// later agent-backend integration (Codex, OpenClaw, Kiro) normalizes toward. All
// token fields + `model` are NULLABLE (a backend fills only what it can obtain);
// `source` is always set so partial data is interpretable. Tokens ONLY — no cost
// field this slice (the elaboration-locked scope decision).
//
/**
 * @typedef {Object} TokenUsage
 * @property {number|null} inputTokens          New (non-cache) input tokens.
 * @property {number|null} outputTokens         Generated tokens.
 * @property {number|null} cacheCreationTokens  Cache-WRITE tokens (Claude only; others null).
 * @property {number|null} cacheReadTokens      Cache-READ tokens.
 * @property {string|null} model                Model id (canonical where known). NOT read from
 *                                              the `usage` object — Anthropic's usage carries no
 *                                              model key (verified against a live CLI stream).
 * @property {string} source                    Backend id — always set (e.g. "claude_code").
 */

/** The `source` tag stamped on usage captured from a Claude Code stream. */
export const CLAUDE_CODE_USAGE_SOURCE = "claude_code";

/** The `source` tag stamped on usage captured from a Codex stream. MUST equal the
 * daemon's Codex client type (`"codex"`, per cli/daemon-agent.mjs `backendClientType`)
 * so persisted usage is attributable to the right backend / connection. */
export const CODEX_USAGE_SOURCE = "codex";
export const DSH_USAGE_SOURCE = "dsh";

/**
 * Coerce a value to a non-negative integer token count, or null. Guards against a
 * CLI that ever emits a string / float / negative — a garbled count becomes null
 * (renders no badge) rather than a bogus number. Never throws.
 * @param {unknown} v
 * @returns {number|null}
 */
function toTokenInt(v) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return Math.round(v);
}

/**
 * Extract the AUTHORITATIVE per-turn token usage from a Claude Code stream object,
 * or null when the object is not a usage-bearing `result` envelope.
 *
 * Source of truth = the `type:"result"` envelope's `.usage` (verified against a live
 * `claude -p --output-format stream-json --verbose` capture, CLI 2.1.x): it carries
 * the cumulative token counts for the WHOLE turn, so we read THAT and never sum the
 * per-message `assistant.message.usage` frames (double-count avoidance — the
 * elaboration-locked decision). The on-disk JSONL is never consulted (its
 * output_tokens is a known upstream placeholder, anthropics/claude-code#25941).
 *
 * Token field names on `.usage` are canonical snake_case: `input_tokens`,
 * `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`.
 *
 * MODEL LOCATION (verified, non-obvious): `.usage` carries NO model key, and on a
 * Bedrock-backed run the envelope's top-level `.model` is `null`. The model is only
 * reliably present in the `.modelUsage` map (keyed by model id, each entry exposing a
 * clean `canonicalModel`). We therefore source `model` from: top-level `.model` when a
 * non-empty string, else the `canonicalModel` (or the key) of the first `.modelUsage`
 * entry, else null. Never from `.usage`.
 *
 * Returns null for every non-result frame (system/assistant/user), so the existing
 * `extractTranscriptText` path is completely untouched. Never throws — an unrecognized
 * shape yields null (defensive against CLI drift).
 *
 * @param {any} obj  One parsed stream NDJSON object.
 * @returns {TokenUsage | null}
 */
export function extractTurnUsage(obj) {
  if (!obj || typeof obj !== "object" || obj.type !== "result") return null;
  const usage = obj.usage;
  if (!usage || typeof usage !== "object") return null;

  // Model: prefer a non-empty top-level string; else the modelUsage map's canonical
  // name (or its key). Never the `usage` object.
  let model = typeof obj.model === "string" && obj.model.trim() ? obj.model : null;
  if (!model && obj.modelUsage && typeof obj.modelUsage === "object") {
    const keys = Object.keys(obj.modelUsage);
    if (keys.length > 0) {
      const first = obj.modelUsage[keys[0]];
      const canonical =
        first && typeof first === "object" && typeof first.canonicalModel === "string"
          ? first.canonicalModel
          : null;
      model = canonical || keys[0] || null;
    }
  }

  return {
    inputTokens: toTokenInt(usage.input_tokens),
    outputTokens: toTokenInt(usage.output_tokens),
    cacheCreationTokens: toTokenInt(usage.cache_creation_input_tokens),
    cacheReadTokens: toTokenInt(usage.cache_read_input_tokens),
    model,
    source: CLAUDE_CODE_USAGE_SOURCE,
  };
}

/**
 * Extract the per-turn token usage from a Codex `codex exec --json` stream object,
 * or null when the object is not a usage-bearing `turn.completed` event. The Codex
 * counterpart to {@link extractTurnUsage} — the two are discriminated purely by the
 * top-level event type (`turn.completed` vs `result`), which are disjoint, so no
 * backend flag is needed (same as `extractTranscriptText`'s dual dialect).
 *
 * Source of truth = the `turn.completed` event's `.usage` (verified against a live
 * `codex exec --json` run on codex-cli 0.145.0 and ../codex/codex-rs/exec/src/exec_events.rs
 * `Usage`). Field names are snake_case: `input_tokens`, `cached_input_tokens`,
 * `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`.
 *
 * Mapping into the shared TokenUsage shape:
 *   • inputTokens         ← input_tokens
 *   • outputTokens        ← output_tokens  (ALONE — see below; matches Claude, whose
 *       output already folds thinking.)
 *   • cacheReadTokens     ← cached_input_tokens
 *   • cacheCreationTokens ← cache_write_input_tokens
 *   • model               ← null  (the Codex --json stream carries no model id on ANY event)
 *   • source              ← CODEX_USAGE_SOURCE
 *
 * `reasoning_output_tokens` is deliberately NOT added to `output_tokens`: in Codex /
 * the OpenAI Responses API it is a SUBDIVISION *inside* `output_tokens`
 * (`output_tokens_details.reasoning_tokens`), not a separate bucket — adding it would
 * double-count. Verified against ../codex/codex-rs/codex-api/src/sse/responses.rs
 * (`From<ResponseCompletedUsage>` sources reasoning_output_tokens from the output
 * details; its test asserts input:100 + output:10 = total:110 with reasoning:5 inside
 * output) and protocol.rs `blended_total()` = non_cached_input + output_tokens (reasoning
 * is shown only as a parenthetical, never summed).
 *
 * An older codex-cli that omits `cache_write_input_tokens` degrades gracefully (reads
 * null) — no version pin. Every numeric field is `toTokenInt`-guarded (garble → null).
 * Returns null for every non-`turn.completed` frame (item.completed/thread.started/
 * turn.started AND Claude's `result`), so the transcript-text path and the Claude usage
 * path are both untouched. Never throws — an unrecognized shape yields null (defensive
 * against CLI drift).
 *
 * @param {any} obj  One parsed stream NDJSON object.
 * @returns {TokenUsage | null}
 */
export function extractCodexTurnUsage(obj) {
  if (!obj || typeof obj !== "object" || obj.type !== "turn.completed") return null;
  const usage = obj.usage;
  if (!usage || typeof usage !== "object") return null;

  return {
    inputTokens: toTokenInt(usage.input_tokens),
    // output_tokens ALREADY includes reasoning_output_tokens (a subdivision, not a
    // separate bucket) — do NOT add reasoning or it double-counts.
    outputTokens: toTokenInt(usage.output_tokens),
    cacheCreationTokens: toTokenInt(usage.cache_write_input_tokens),
    cacheReadTokens: toTokenInt(usage.cached_input_tokens),
    model: null, // Codex stream carries no model id on any event
    source: CODEX_USAGE_SOURCE,
  };
}

/** Extract the normalized terminal usage frame emitted by DshSpawner. */
export function extractDshTurnUsage(obj) {
  if (!obj || typeof obj !== "object" || obj.type !== "dsh.turn.completed") return null;
  const usage = obj.usage;
  if (!usage || typeof usage !== "object") return null;
  return {
    inputTokens: toTokenInt(usage.inputTokens),
    outputTokens: toTokenInt(usage.outputTokens),
    cacheCreationTokens: toTokenInt(usage.cacheCreationTokens),
    cacheReadTokens: toTokenInt(usage.cacheReadTokens),
    model: typeof usage.model === "string" && usage.model.trim() ? usage.model : null,
    source: DSH_USAGE_SOURCE,
  };
}

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
 * Four stream dialects are recognized (their top-level shapes are disjoint, so no
 * backend flag is needed):
 *  - Claude Code stream-json: `{ type: "user"|"assistant", message: { content … } }`.
 *  - DeepSeek Harness (dsh): `{ type: "user/message"|"assistant/message", data: { message } }`.
 *  - codex `codex exec --json`: conversation/tool output rides on `item.completed`
 *    events discriminated by `item.type`; assistant text is an `agent_message`
 *    item with a top-level `item.text` (verified against codex-cli 0.142.3). codex
 *    does NOT echo the user prompt (the chat UI renders that from the turn's
 *    promptText), and `reasoning` / `command_execution` / lifecycle envelopes are
 *    not conversation text — all dropped.
 *  - pi (@earendil-works/pi-coding-agent) `pi --mode json`: AgentSessionEvents whose
 *    authoritative final text is a `message_end` carrying a full AgentMessage
 *    (`{ role, content }`). We keep ONLY the assistant message: pi UNCONDITIONALLY
 *    re-emits the wake prompt as a `message_end` with role "user" (agent-loop.ts),
 *    which the daemon already stores as the turn's promptText — so echoing it would
 *    duplicate the prompt (same reason codex drops the user echo). `toolResult`
 *    messages and `tool_execution_end` tool-output events are not conversation text.
 *    pi's content-block shape is identical to Claude's (text blocks `{type:"text",text}`,
 *    thinking `{type:"thinking"}`, tool calls `{type:"toolCall"}`), so we normalize the
 *    assistant envelope to the Claude shape and reuse the same block extractor.
 *
 * @param {any} obj  One parsed stream NDJSON object.
 * @returns {{ role: "user"|"assistant", text: string } | null}
 */
export function extractTranscriptText(obj) {
  if (!obj || typeof obj !== "object") return null;

  // ── DeepSeek Harness committed session-event dialect ──
  if (obj.type === "user/message" || obj.type === "assistant/message") {
    const data = obj.data;
    const message = data && typeof data === "object" ? data.message : null;
    if (!message || typeof message !== "object") return null;
    return extractTranscriptText({
      type: obj.type === "user/message" ? "user" : "assistant",
      message,
    });
  }

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

  // ── pi `pi --mode json` dialect ──
  // pi's authoritative final text of each step is a `message_end` carrying a full
  // AgentMessage `{ role, content }`. Keep ONLY the assistant message: pi re-emits the
  // wake prompt as a role:"user" message_end (already stored as the turn's promptText),
  // and role:"toolResult" / `tool_execution_end` events are tool output, not text.
  // pi's content-block shape matches Claude's, so we hand the message to the Claude-shape
  // extractor below (which keeps only `{type:"text"}` blocks, strips reminders, drops empties).
  if (obj.type === "message_end") {
    const message = obj.message;
    if (!message || typeof message !== "object" || message.role !== "assistant") return null;
    return extractTranscriptText({ type: "assistant", message });
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

  // NOTE ON SCOPE: this instance's `currentSessionId` / `pending` / `chain` /
  // `lastRelayError` are per-hook-instance, and the daemon builds ONE transcript-hook
  // instance per connection (per cwd) — see daemon.mjs. The per-(agent,session) WakeQueue
  // serializes wakes of the SAME session, but different sessions (root-idea keys) on the
  // same cwd can run concurrently (maxConcurrency). This single-session-batching state
  // therefore assumes at most one ACTIVE session producing transcript at a time on a given
  // cwd, which holds for today's usage (one dispatched conversation per cwd at a time); it
  // is NOT a general guarantee. `lastRelayError` inherits exactly this scope — no stronger,
  // no weaker — so it is only as isolated as the batching state it rides alongside.
  //
  // The session this batch belongs to (set by onSessionStart, and re-affirmed by each
  // message's observed session id from the stream). Messages queued for one session
  // are flushed before the session changes, so they always target the right turn.
  let currentSessionId = null;
  /** @type {Array<{ role: "user"|"assistant", text: string }>} */
  let pending = [];
  let timer = null;
  // Serialize POSTs so an earlier batch can never land after a later one on the wire.
  let chain = Promise.resolve();
  // The final upload failure reason for the current session's most recent batch, or null
  // when the last upload succeeded/was skipped (fix #444 follow-up). `onSessionEnd`
  // returns this so the waker can annotate the terminal turn with WHY its transcript is
  // missing. Reset in `onSessionStart`; set only when a batch exhausts its retry budget
  // (a transient failure that a later batch recovers is NOT surfaced). Its isolation is
  // exactly the single-active-session scope described above.
  let lastRelayError = null;
  // The most recent per-turn token usage seen on THIS session's stream (daemon-token-usage).
  // Captured from the authoritative `result` envelope in `onTranscriptMessage`; the LAST one
  // wins (a turn emits exactly one result frame, but last-wins is safe either way). Returned
  // by `onSessionEnd` so the waker forwards it onto the terminal turn-advance. Shares EXACTLY
  // the single-active-session scope of `lastRelayError` above — no stronger, no weaker. Reset
  // in `onSessionStart` so a new wake never inherits the prior turn's usage.
  /** @type {TokenUsage|null} */
  let lastUsage = null;

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
      // A new wake starts → clear the previous wake's relay error so a stale drop from an
      // earlier turn isn't re-reported here (fix #444 follow-up). This is sequential-reuse
      // hygiene; it does NOT defend against two sessions overlapping on one hook instance
      // (see the scope note where `lastRelayError` is declared).
      lastRelayError = null;
      // Same hygiene for token usage (daemon-token-usage): a new wake must not inherit the
      // prior turn's usage. Cleared here so a turn that emits NO result frame reports null.
      lastUsage = null;
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
      // Capture per-turn token usage from EITHER backend's authoritative usage frame
      // (daemon-token-usage): the Claude Code `result` envelope or the Codex
      // `turn.completed` event. The two extractors are discriminated purely by top-level
      // event type (disjoint), so at most one returns non-null — same dual-dialect pattern
      // as extractTranscriptText. Returns null for every other frame, so this is a cheap
      // no-op on the vast majority of lines and never touches the transcript path. Guarded
      // so a malformed frame can never break transcript relay (no-silent: warn).
      try {
        const usage =
          extractTurnUsage(message) ??
          extractCodexTurnUsage(message) ??
          extractDshTurnUsage(message);
        if (usage) lastUsage = usage;
      } catch (err) {
        logger.warn(`[Chorus] token usage extract failed: ${err}`);
      }
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
     * Returns `{ relayError, usage }`: `relayError` is the final terminal upload failure
     * reason (retry exhausted) after the flush settles, or null when every batch landed
     * (the waker forwards it so a KNOWN relay drop is surfaced rather than misread as "no
     * reply received", fix #444 follow-up). `usage` is the turn's authoritative per-turn
     * token usage captured from the `result` frame, or null when none was seen
     * (daemon-token-usage) — the waker forwards it onto the same terminal turn-advance.
     * @param {{ sessionId?: string }} info
     * @returns {Promise<{ relayError: string|null, usage: TokenUsage|null }>}
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
      // exhaustion, cleared on success) — read it AFTER the chain settles. `lastUsage` is
      // the turn's authoritative token usage (null if the run emitted no result frame).
      return { relayError: lastRelayError, usage: lastUsage };
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

// cli/__tests__/transcript-upload-hooks.test.mjs
// Covers daemon-session-conversation (子1) step 6: the transcript upload hooks.
// `onTranscriptMessage` keeps ONLY user/assistant text (dropping system/result
// envelopes and thinking/tool_use/tool_result blocks), batches them, and POSTs to
// /api/daemon/transcript for the current turn's session. `onSessionStart` pins the
// session so subsequent messages attach to the right turn. The fire-and-forget +
// warn-not-throw contract: an upload failure is LOGGED and never throws into the wake.
//
// Stream-json fixtures below are REAL shapes captured from Claude Code CLI 2.1.183
// (verified against the install, per the task's hallucination guard), not invented.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  extractTranscriptText,
  extractTurnUsage,
  extractCodexTurnUsage,
  CLAUDE_CODE_USAGE_SOURCE,
  CODEX_USAGE_SOURCE,
  createTranscriptUploadHooks,
  mergeUploadHooks,
  createExecutionUploadHooks,
  createNoopUploadHooks,
} from "../upload-hooks.mjs";

const silent = { info() {}, warn() {}, error() {} };

// ── Real captured stream-json envelopes (Claude Code 2.1.183) ──
const SID = "e2dc21d0-3071-4bf7-84ae-f2c6dbe8ff24";

const SYSTEM_INIT = { type: "system", subtype: "init", session_id: SID };
const SYSTEM_THINKING_TOKENS = { type: "system", subtype: "thinking_tokens", session_id: SID };

const ASSISTANT_THINKING = {
  type: "assistant",
  session_id: SID,
  message: { role: "assistant", content: [{ type: "thinking", thinking: "Let me think about this." }] },
};
const ASSISTANT_TOOL_USE = {
  type: "assistant",
  session_id: SID,
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/etc/hostname" } }],
  },
};
const USER_TOOL_RESULT = {
  type: "user",
  session_id: SID,
  message: { role: "user", content: [{ tool_use_id: "toolu_1", type: "tool_result", content: "1\tip-172\n" }] },
};
const ASSISTANT_TEXT = {
  type: "assistant",
  session_id: SID,
  message: { role: "assistant", content: [{ type: "text", text: "The hostname is `ip-172`." }] },
};
const USER_TEXT_STRING = {
  type: "user",
  session_id: SID,
  message: { role: "user", content: "Please read /etc/hostname." },
};
const RESULT_ENVELOPE = { type: "result", subtype: "success", session_id: SID, result: "done" };

// ── Harness-injected synthetic content (Claude Code 2.1.195) ──
// A loaded skill body is delivered to the model as a synthetic user turn. On the live
// `claude -p --output-format stream-json --verbose` stdout the daemon reads, it is a
// `type:"user"` envelope carrying a `text` block, marked `isSynthetic:true`. (The
// on-disk JSONL marks the same message `isMeta:true` — a DIFFERENT field name; the
// daemon reads the stream, so the guard keys on `isSynthetic`. Verified by capturing
// real stdout from the installed CLI, not from memory.)
const USER_SKILL_BODY_SYNTHETIC = {
  type: "user",
  session_id: SID,
  isSynthetic: true,
  message: {
    role: "user",
    content: [{ type: "text", text: "Base directory for this skill: /home/u/.claude/plugins/...\n\n# Idea Skill\n..." }],
  },
};
// A human wake instruction is a NON-synthetic user text message — must still sync.
const USER_HUMAN_INSTRUCTION = {
  type: "user",
  session_id: SID,
  message: { role: "user", content: [{ type: "text", text: "[Chorus] New instruction from a human: please claim it." }] },
};
// A genuine assistant reply that merely QUOTES a skill string — must NOT be dropped
// (proves the filter is structural on isSynthetic, not content-sniffing).
const ASSISTANT_QUOTES_SKILL = {
  type: "assistant",
  session_id: SID,
  message: {
    role: "assistant",
    content: [{ type: "text", text: 'I read the "Base directory for this skill" line and proceeded.' }],
  },
};
// A retained, non-synthetic text block that wraps a <system-reminder> alongside real text.
const USER_TEXT_WITH_REMINDER = {
  type: "user",
  session_id: SID,
  message: {
    role: "user",
    content: [{ type: "text", text: "Real instruction.<system-reminder>internal note</system-reminder> Keep going." }],
  },
};
// A message that is ONLY a system-reminder — nothing real remains after stripping.
const USER_REMINDER_ONLY = {
  type: "user",
  session_id: SID,
  message: {
    role: "user",
    content: [{ type: "text", text: "<system-reminder>ambient context, not user input</system-reminder>" }],
  },
};

describe("extractTranscriptText — keep user/assistant text, drop everything else", () => {
  it("keeps an assistant text message", () => {
    expect(extractTranscriptText(ASSISTANT_TEXT)).toEqual({
      role: "assistant",
      text: "The hostname is `ip-172`.",
    });
  });

  it("keeps a user message whose content is a plain string", () => {
    expect(extractTranscriptText(USER_TEXT_STRING)).toEqual({
      role: "user",
      text: "Please read /etc/hostname.",
    });
  });

  it("drops a thinking block (assistant)", () => {
    expect(extractTranscriptText(ASSISTANT_THINKING)).toBeNull();
  });

  it("drops a tool_use block (assistant)", () => {
    expect(extractTranscriptText(ASSISTANT_TOOL_USE)).toBeNull();
  });

  it("drops a tool_result block (rides inside a type:user message)", () => {
    expect(extractTranscriptText(USER_TOOL_RESULT)).toBeNull();
  });

  it("drops system envelopes (init, thinking_tokens, hooks)", () => {
    expect(extractTranscriptText(SYSTEM_INIT)).toBeNull();
    expect(extractTranscriptText(SYSTEM_THINKING_TOKENS)).toBeNull();
  });

  it("drops the result envelope", () => {
    expect(extractTranscriptText(RESULT_ENVELOPE)).toBeNull();
  });

  it("concatenates multiple text blocks of one message into one entry", () => {
    const multi = {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }] },
    };
    expect(extractTranscriptText(multi)).toEqual({ role: "assistant", text: "Hello world" });
  });

  it("keeps only the text blocks when text is mixed with tool_use", () => {
    const mixed = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Reading now." },
          { type: "tool_use", id: "t", name: "Read", input: {} },
        ],
      },
    };
    expect(extractTranscriptText(mixed)).toEqual({ role: "assistant", text: "Reading now." });
  });

  it("drops a message whose text is only whitespace", () => {
    const blank = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "   " }] } };
    expect(extractTranscriptText(blank)).toBeNull();
  });

  it("never throws on malformed / non-object / missing-message input (returns null)", () => {
    expect(extractTranscriptText(null)).toBeNull();
    expect(extractTranscriptText(undefined)).toBeNull();
    expect(extractTranscriptText("a string")).toBeNull();
    expect(extractTranscriptText(42)).toBeNull();
    expect(extractTranscriptText({})).toBeNull();
    expect(extractTranscriptText({ type: "assistant" })).toBeNull(); // no .message
    expect(extractTranscriptText({ type: "assistant", message: {} })).toBeNull(); // no content
    expect(extractTranscriptText({ type: "assistant", message: { content: 7 } })).toBeNull(); // weird content
  });

  it("falls back to the envelope type when message.role is absent", () => {
    const noRole = { type: "user", message: { content: [{ type: "text", text: "hi" }] } };
    expect(extractTranscriptText(noRole)).toEqual({ role: "user", text: "hi" });
  });
});

describe("extractTranscriptText — exclude harness-injected synthetic content", () => {
  it("drops a type:user isSynthetic:true skill-body message (no body leaks)", () => {
    expect(extractTranscriptText(USER_SKILL_BODY_SYNTHETIC)).toBeNull();
  });

  it("keeps a NON-synthetic [Chorus] human instruction", () => {
    expect(extractTranscriptText(USER_HUMAN_INSTRUCTION)).toEqual({
      role: "user",
      text: "[Chorus] New instruction from a human: please claim it.",
    });
  });

  it("does NOT drop an assistant reply that merely quotes a skill string (structural, not content-sniffing)", () => {
    expect(extractTranscriptText(ASSISTANT_QUOTES_SKILL)).toEqual({
      role: "assistant",
      text: 'I read the "Base directory for this skill" line and proceeded.',
    });
  });

  it("does NOT drop a synthetic ASSISTANT message — the guard is gated on type:user only", () => {
    // An assistant envelope marked isSynthetic must still be kept (real assistant text);
    // the synthetic drop is scoped to user envelopes (where injected content rides).
    const synthAssistant = {
      type: "assistant",
      isSynthetic: true,
      message: { role: "assistant", content: [{ type: "text", text: "still my reply" }] },
    };
    expect(extractTranscriptText(synthAssistant)).toEqual({ role: "assistant", text: "still my reply" });
  });

  it("strips a <system-reminder> span from retained text but keeps the real text", () => {
    expect(extractTranscriptText(USER_TEXT_WITH_REMINDER)).toEqual({
      role: "user",
      text: "Real instruction. Keep going.",
    });
  });

  it("drops a message that is only a <system-reminder> after stripping", () => {
    expect(extractTranscriptText(USER_REMINDER_ONLY)).toBeNull();
  });
});

// ── Real captured codex `codex exec --json` event shapes (codex-cli 0.142.3) ──
// Codex's stream is structurally different from Claude's: conversation/tool output
// arrives as `item.completed` events whose `item.type` discriminates. Assistant
// text is an `agent_message` item with a top-level `item.text` (verified live —
// the user prompt is NOT echoed by codex; the chat UI renders it from the turn's
// promptText instead, so the extractor only needs to surface assistant text).
const CODEX_THREAD_STARTED = { type: "thread.started", thread_id: "019f0bf0-10b3-7b52-82ab-57e97481fbd1" };
const CODEX_TURN_STARTED = { type: "turn.started" };
const CODEX_AGENT_MESSAGE = {
  type: "item.completed",
  item: { id: "item_0", type: "agent_message", text: "The hostname is `ip-172`." },
};
const CODEX_TURN_COMPLETED = { type: "turn.completed", usage: { input_tokens: 13714, output_tokens: 6 } };
const CODEX_REASONING = {
  type: "item.completed",
  item: { id: "item_1", type: "reasoning", text: "Let me think." },
};
const CODEX_COMMAND_EXEC = {
  type: "item.completed",
  item: { id: "item_2", type: "command_execution", command: "ls", aggregated_output: "a\nb\n" },
};

describe("extractTranscriptText — codex exec --json shape", () => {
  it("keeps a codex agent_message item as assistant text", () => {
    expect(extractTranscriptText(CODEX_AGENT_MESSAGE)).toEqual({
      role: "assistant",
      text: "The hostname is `ip-172`.",
    });
  });

  it("drops codex lifecycle envelopes (thread.started / turn.started / turn.completed)", () => {
    expect(extractTranscriptText(CODEX_THREAD_STARTED)).toBeNull();
    expect(extractTranscriptText(CODEX_TURN_STARTED)).toBeNull();
    expect(extractTranscriptText(CODEX_TURN_COMPLETED)).toBeNull();
  });

  it("drops a codex reasoning item (model thinking — not conversation text)", () => {
    expect(extractTranscriptText(CODEX_REASONING)).toBeNull();
  });

  it("drops a codex command_execution item (tool activity, not assistant text)", () => {
    expect(extractTranscriptText(CODEX_COMMAND_EXEC)).toBeNull();
  });

  it("drops a codex agent_message with only-whitespace text", () => {
    const blank = { type: "item.completed", item: { type: "agent_message", text: "   " } };
    expect(extractTranscriptText(blank)).toBeNull();
  });

  it("drops a codex item.completed with no item / missing text", () => {
    expect(extractTranscriptText({ type: "item.completed" })).toBeNull();
    expect(extractTranscriptText({ type: "item.completed", item: { type: "agent_message" } })).toBeNull();
  });
});

/** A fake server: records every POST body and answers ok unless told otherwise. */
function fakeServer({ ok = true, status = 200 } = {}) {
  const posts = [];
  const fetchImpl = vi.fn(async (url, init) => {
    posts.push({ url: String(url), init, body: JSON.parse(init.body) });
    return { ok, status, async json() { return { success: ok, data: {} }; } };
  });
  return { posts, fetchImpl };
}

describe("createTranscriptUploadHooks — batching + POST", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Run pending debounce timers, then let the serialized upload chain settle. */
  async function flush() {
    await vi.runAllTimersAsync();
  }

  it("batches a burst of messages into ONE POST with only user/assistant text", async () => {
    const { posts, fetchImpl } = fakeServer();
    const hooks = createTranscriptUploadHooks({
      url: "https://chorus.example/",
      apiKey: "cho_secret",
      logger: silent,
      fetchImpl,
      batchDelayMs: 50,
    });

    await hooks.onSessionStart({ rootIdeaKey: `idea:${SID}`, sessionId: SID, isNew: true });
    // A realistic burst: thinking, tool_use, tool_result are dropped; two texts kept.
    await hooks.onTranscriptMessage({ sessionId: SID, message: ASSISTANT_THINKING });
    await hooks.onTranscriptMessage({ sessionId: SID, message: ASSISTANT_TOOL_USE });
    await hooks.onTranscriptMessage({ sessionId: SID, message: USER_TOOL_RESULT });
    await hooks.onTranscriptMessage({ sessionId: SID, message: USER_TEXT_STRING });
    await hooks.onTranscriptMessage({ sessionId: SID, message: ASSISTANT_TEXT });

    expect(fetchImpl).not.toHaveBeenCalled(); // debounced — nothing yet
    await flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const { url, init, body } = posts[0];
    expect(url).toBe("https://chorus.example/api/daemon/transcript");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer cho_secret",
      "Content-Type": "application/json",
    });
    expect(body).toEqual({
      sessionId: SID,
      messages: [
        { role: "user", text: "Please read /etc/hostname." },
        { role: "assistant", text: "The hostname is `ip-172`." },
      ],
    });
  });

  it("does NOT post when a turn produced no user/assistant text (all dropped)", async () => {
    const { fetchImpl } = fakeServer();
    const hooks = createTranscriptUploadHooks({ url: "https://c", apiKey: "k", logger: silent, fetchImpl });
    await hooks.onSessionStart({ sessionId: SID, isNew: true });
    await hooks.onTranscriptMessage({ sessionId: SID, message: ASSISTANT_THINKING });
    await hooks.onTranscriptMessage({ sessionId: SID, message: ASSISTANT_TOOL_USE });
    await hooks.onTranscriptMessage({ sessionId: SID, message: USER_TOOL_RESULT });
    await hooks.onTranscriptMessage({ sessionId: SID, message: SYSTEM_INIT });
    await flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("attributes messages to the session id observed ON THE STREAM (no onSessionStart)", async () => {
    const { posts, fetchImpl } = fakeServer();
    const hooks = createTranscriptUploadHooks({ url: "https://c", apiKey: "k", logger: silent, fetchImpl });
    // onSessionStart never called; the stream's session id is used instead.
    await hooks.onTranscriptMessage({ sessionId: SID, message: ASSISTANT_TEXT });
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0].body.sessionId).toBe(SID);
  });

  it("flushes the prior session's batch before re-pinning to a new session", async () => {
    const { posts, fetchImpl } = fakeServer();
    const hooks = createTranscriptUploadHooks({ url: "https://c", apiKey: "k", logger: silent, fetchImpl });
    const SID2 = "11111111-1111-4111-8111-111111111111";

    await hooks.onSessionStart({ sessionId: SID, isNew: true });
    await hooks.onTranscriptMessage({ sessionId: SID, message: ASSISTANT_TEXT });
    // New session starts before the debounce fired — the old batch must flush to SID.
    await hooks.onSessionStart({ sessionId: SID2, isNew: true });
    await hooks.onTranscriptMessage({ sessionId: SID2, message: USER_TEXT_STRING });
    await flush();

    expect(posts).toHaveLength(2);
    const bySession = Object.fromEntries(posts.map((p) => [p.body.sessionId, p.body.messages]));
    expect(bySession[SID]).toEqual([{ role: "assistant", text: "The hostname is `ip-172`." }]);
    expect(bySession[SID2]).toEqual([{ role: "user", text: "Please read /etc/hostname." }]);
  });

  it("drops a batch with no session id (visible warning, no POST)", async () => {
    const warns = [];
    const { fetchImpl } = fakeServer();
    const hooks = createTranscriptUploadHooks({
      url: "https://c",
      apiKey: "k",
      logger: { ...silent, warn: (m) => warns.push(m) },
      fetchImpl,
    });
    // A keepable message but with NO session id anywhere → can't attribute.
    await hooks.onTranscriptMessage({ message: ASSISTANT_TEXT });
    await flush();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warns.join("")).toMatch(/no session id/i);
  });
});

describe("createTranscriptUploadHooks — warn-not-throw (fire-and-forget)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a network failure is logged and never throws into the wake path", async () => {
    const warns = [];
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const hooks = createTranscriptUploadHooks({
      url: "https://c",
      apiKey: "k",
      logger: { ...silent, warn: (m) => warns.push(m) },
      fetchImpl,
    });
    await hooks.onSessionStart({ sessionId: SID, isNew: true });
    // The hook call itself must not reject.
    await expect(hooks.onTranscriptMessage({ sessionId: SID, message: ASSISTANT_TEXT })).resolves.toBeUndefined();
    await vi.runAllTimersAsync();
    expect(warns.join("")).toMatch(/transcript upload request failed/i);
  });

  it("a non-2xx response is logged and non-fatal", async () => {
    const warns = [];
    const { fetchImpl } = fakeServer({ ok: false, status: 404 });
    const hooks = createTranscriptUploadHooks({
      url: "https://c",
      apiKey: "k",
      logger: { ...silent, warn: (m) => warns.push(m) },
      fetchImpl,
    });
    await hooks.onSessionStart({ sessionId: SID, isNew: true });
    await hooks.onTranscriptMessage({ sessionId: SID, message: ASSISTANT_TEXT });
    await vi.runAllTimersAsync();
    expect(warns.join("")).toMatch(/transcript upload returned 404/);
  });

  it("a permanently failing batch does not wedge the chain — a later batch still posts", async () => {
    let call = 0;
    const posts = [];
    // First batch fails EVERY retry attempt (3), so it is dropped; later calls succeed.
    const fetchImpl = vi.fn(async (url, init) => {
      call += 1;
      if (call <= 3) throw new Error("boom");
      posts.push(JSON.parse(init.body));
      return { ok: true, status: 200, async json() { return {}; } };
    });
    // retryBackoffMs: 0 keeps the test fast under fake timers.
    const hooks = createTranscriptUploadHooks({
      url: "https://c",
      apiKey: "k",
      logger: silent,
      fetchImpl,
      retryBackoffMs: 0,
    });

    await hooks.onSessionStart({ sessionId: SID, isNew: true });
    await hooks.onTranscriptMessage({ sessionId: SID, message: ASSISTANT_TEXT });
    await vi.runAllTimersAsync();
    // Second turn/batch after the first was dropped — the chain must not be wedged.
    await hooks.onTranscriptMessage({ sessionId: SID, message: USER_TEXT_STRING });
    await vi.runAllTimersAsync();

    // batch 1: 3 failed attempts (then dropped). batch 2: 1 successful attempt.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(posts).toHaveLength(1);
    expect(posts[0].messages).toEqual([{ role: "user", text: "Please read /etc/hostname." }]);
  });
});

describe("createTranscriptUploadHooks — flush-on-exit (onSessionEnd, fix #444)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("onSessionEnd flushes a still-buffered batch and awaits it (no lost trailing transcript)", async () => {
    const { posts, fetchImpl } = fakeServer();
    const hooks = createTranscriptUploadHooks({
      url: "https://c",
      apiKey: "k",
      logger: silent,
      fetchImpl,
      batchDelayMs: 50,
    });

    await hooks.onSessionStart({ sessionId: SID, isNew: true });
    // A trailing reply arrives; the subprocess then exits WITHIN the debounce window
    // (nothing posted yet).
    await hooks.onTranscriptMessage({ sessionId: SID, message: ASSISTANT_TEXT });
    expect(fetchImpl).not.toHaveBeenCalled();

    // The waker calls onSessionEnd BEFORE advancing the turn to ended. Awaiting it must
    // drain the buffered batch — without needing the debounce timer to fire.
    await hooks.onSessionEnd({ sessionId: SID });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({
      sessionId: SID,
      messages: [{ role: "assistant", text: "The hostname is `ip-172`." }],
    });
  });

  it("onSessionEnd cancels the pending debounce timer (no duplicate POST when timers later run)", async () => {
    const { posts, fetchImpl } = fakeServer();
    const hooks = createTranscriptUploadHooks({
      url: "https://c",
      apiKey: "k",
      logger: silent,
      fetchImpl,
      batchDelayMs: 50,
    });
    await hooks.onSessionStart({ sessionId: SID, isNew: true });
    await hooks.onTranscriptMessage({ sessionId: SID, message: ASSISTANT_TEXT });
    await hooks.onSessionEnd({ sessionId: SID });
    // Any leftover debounce timer must have been cancelled by the flush.
    await vi.runAllTimersAsync();
    expect(posts).toHaveLength(1);
  });

  it("onSessionEnd re-affirms the session id when the stream never set one", async () => {
    const { posts, fetchImpl } = fakeServer();
    const hooks = createTranscriptUploadHooks({ url: "https://c", apiKey: "k", logger: silent, fetchImpl });
    // No onSessionStart, and the message carries no session id — but the waker knows it.
    await hooks.onTranscriptMessage({ message: ASSISTANT_TEXT });
    await hooks.onSessionEnd({ sessionId: SID });
    expect(posts).toHaveLength(1);
    expect(posts[0].body.sessionId).toBe(SID);
  });

  it("onSessionEnd is a no-op (no POST) when nothing is buffered", async () => {
    const { fetchImpl } = fakeServer();
    const hooks = createTranscriptUploadHooks({ url: "https://c", apiKey: "k", logger: silent, fetchImpl });
    await hooks.onSessionStart({ sessionId: SID, isNew: true });
    // Nothing buffered → no upload happened → no relay error to surface, and no usage seen.
    await expect(hooks.onSessionEnd({ sessionId: SID })).resolves.toEqual({
      relayError: null,
      usage: null,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("onSessionEnd never throws even when the flush POST fails", async () => {
    const warns = [];
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const hooks = createTranscriptUploadHooks({
      url: "https://c",
      apiKey: "k",
      logger: { ...silent, warn: (m) => warns.push(m) },
      fetchImpl,
      retryBackoffMs: 0,
      // Resolve the backoff synchronously — under fake timers a setTimeout-backed sleep
      // would never fire while we await the flush chain directly (no runAllTimers here).
      sleepImpl: () => Promise.resolve(),
    });
    await hooks.onSessionStart({ sessionId: SID, isNew: true });
    await hooks.onTranscriptMessage({ sessionId: SID, message: ASSISTANT_TEXT });
    // Never throws; resolves with the relay error (a network cause) rather than crashing.
    const outcome = await hooks.onSessionEnd({ sessionId: SID });
    expect(outcome.relayError).toMatch(/transcript upload request failed/i);
    // The failure is surfaced (no silent errors) but never crashes the wake exit path.
    expect(warns.join("")).toMatch(/transcript upload/i);
  });
});

describe("createTranscriptUploadHooks — bounded upload retry (fix #444)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("retries a transient failure and then succeeds (no transcript lost)", async () => {
    let call = 0;
    const posts = [];
    // First attempt returns a transient 502; the retry succeeds.
    const fetchImpl = vi.fn(async (url, init) => {
      call += 1;
      if (call === 1) return { ok: false, status: 502, async json() { return {}; } };
      posts.push(JSON.parse(init.body));
      return { ok: true, status: 200, async json() { return {}; } };
    });
    const hooks = createTranscriptUploadHooks({
      url: "https://c",
      apiKey: "k",
      logger: silent,
      fetchImpl,
      retryBackoffMs: 0,
      sleepImpl: () => Promise.resolve(),
    });
    await hooks.onSessionStart({ sessionId: SID, isNew: true });
    await hooks.onTranscriptMessage({ sessionId: SID, message: ASSISTANT_TEXT });
    await hooks.onSessionEnd({ sessionId: SID });
    expect(fetchImpl).toHaveBeenCalledTimes(2); // 1 failed + 1 retry that succeeded
    expect(posts).toHaveLength(1);
    expect(posts[0].messages).toEqual([{ role: "assistant", text: "The hostname is `ip-172`." }]);
  });

  it("gives up after the attempt cap and drops with a loud warn naming the message count", async () => {
    const warns = [];
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 502, async json() { return {}; } }));
    const hooks = createTranscriptUploadHooks({
      url: "https://c",
      apiKey: "k",
      logger: { ...silent, warn: (m) => warns.push(m) },
      fetchImpl,
      maxUploadAttempts: 3,
      retryBackoffMs: 0,
      sleepImpl: () => Promise.resolve(),
    });
    await hooks.onSessionStart({ sessionId: SID, isNew: true });
    await hooks.onTranscriptMessage({ sessionId: SID, message: ASSISTANT_TEXT });
    await hooks.onTranscriptMessage({ sessionId: SID, message: USER_TEXT_STRING });
    await hooks.onSessionEnd({ sessionId: SID });
    expect(fetchImpl).toHaveBeenCalledTimes(3); // exhausted the 3-attempt budget
    // Dropped loudly, naming how many messages were lost (the batch had 2).
    expect(warns.join("")).toMatch(/gave up after 3 attempt\(s\).*dropping 2 message\(s\)/i);
  });

  it("maxUploadAttempts: 1 disables retry (single-shot)", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 502, async json() { return {}; } }));
    const hooks = createTranscriptUploadHooks({
      url: "https://c",
      apiKey: "k",
      logger: silent,
      fetchImpl,
      maxUploadAttempts: 1,
      retryBackoffMs: 0,
    });
    await hooks.onSessionStart({ sessionId: SID, isNew: true });
    await hooks.onTranscriptMessage({ sessionId: SID, message: ASSISTANT_TEXT });
    await hooks.onSessionEnd({ sessionId: SID });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("createTranscriptUploadHooks — onSessionEnd surfaces the relay error (fix #444 follow-up)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns the final failure reason (non-2xx status) after retries are exhausted", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 502, async json() { return {}; } }));
    const hooks = createTranscriptUploadHooks({
      url: "https://c",
      apiKey: "k",
      logger: silent,
      fetchImpl,
      maxUploadAttempts: 3,
      retryBackoffMs: 0,
      sleepImpl: () => Promise.resolve(),
    });
    await hooks.onSessionStart({ sessionId: SID, isNew: true });
    await hooks.onTranscriptMessage({ sessionId: SID, message: ASSISTANT_TEXT });
    const { relayError } = await hooks.onSessionEnd({ sessionId: SID });
    // The client's structured error carries the status so the UI can name the cause.
    expect(relayError).toMatch(/transcript upload returned 502/i);
  });

  it("returns null when the upload succeeds (no false relay error)", async () => {
    const { fetchImpl } = fakeServer();
    const hooks = createTranscriptUploadHooks({
      url: "https://c",
      apiKey: "k",
      logger: silent,
      fetchImpl,
    });
    await hooks.onSessionStart({ sessionId: SID, isNew: true });
    await hooks.onTranscriptMessage({ sessionId: SID, message: ASSISTANT_TEXT });
    const { relayError } = await hooks.onSessionEnd({ sessionId: SID });
    expect(relayError).toBeNull();
  });

  it("a later successful batch CLEARS an earlier transient failure (not surfaced)", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      // Attempt 1 fails, its retry (attempt 2) succeeds → the reply DID land.
      if (call === 1) return { ok: false, status: 502, async json() { return {}; } };
      return { ok: true, status: 200, async json() { return {}; } };
    });
    const hooks = createTranscriptUploadHooks({
      url: "https://c",
      apiKey: "k",
      logger: silent,
      fetchImpl,
      maxUploadAttempts: 3,
      retryBackoffMs: 0,
      sleepImpl: () => Promise.resolve(),
    });
    await hooks.onSessionStart({ sessionId: SID, isNew: true });
    await hooks.onTranscriptMessage({ sessionId: SID, message: ASSISTANT_TEXT });
    const { relayError } = await hooks.onSessionEnd({ sessionId: SID });
    expect(relayError).toBeNull();
  });

  it("onSessionStart resets a relay error carried from a prior session", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 502, async json() { return {}; } }));
    const hooks = createTranscriptUploadHooks({
      url: "https://c",
      apiKey: "k",
      logger: silent,
      fetchImpl,
      maxUploadAttempts: 1,
      retryBackoffMs: 0,
    });
    // First session fails.
    await hooks.onSessionStart({ sessionId: SID, isNew: true });
    await hooks.onTranscriptMessage({ sessionId: SID, message: ASSISTANT_TEXT });
    expect((await hooks.onSessionEnd({ sessionId: SID })).relayError).toMatch(/502/);
    // A fresh session that produced NO transcript must not inherit the prior error.
    await hooks.onSessionStart({ sessionId: "other-session", isNew: true });
    expect((await hooks.onSessionEnd({ sessionId: "other-session" })).relayError).toBeNull();
  });
});

describe("mergeUploadHooks — compose execution + transcript concerns", () => {
  it("routes onSessionStart/onTranscriptMessage to transcript and onExecutionChange to execution", async () => {
    const calls = [];
    const transcript = {
      ...createNoopUploadHooks(),
      onSessionStart: async () => calls.push("ts:start"),
      onTranscriptMessage: async () => calls.push("ts:msg"),
      onSessionEnd: async () => calls.push("ts:end"),
    };
    const execution = {
      ...createNoopUploadHooks(),
      onExecutionChange: () => calls.push("ex:change"),
    };
    const merged = mergeUploadHooks(execution, transcript, { logger: silent });

    await merged.onSessionStart({ sessionId: SID });
    await merged.onTranscriptMessage({ sessionId: SID, message: ASSISTANT_TEXT });
    await merged.onSessionEnd({ sessionId: SID });
    merged.onExecutionChange();

    expect(calls).toEqual(["ts:start", "ts:msg", "ts:end", "ex:change"]);
  });

  it("a throwing delegate never breaks the others or the caller", async () => {
    const warns = [];
    const good = { ...createNoopUploadHooks(), onSessionStart: async () => warns.push("good ran") };
    const bad = {
      ...createNoopUploadHooks(),
      onSessionStart: async () => {
        throw new Error("delegate boom");
      },
      onExecutionChange: () => {
        throw new Error("sync boom");
      },
    };
    const merged = mergeUploadHooks(bad, good, { logger: { ...silent, warn: (m) => warns.push(m) } });

    await expect(merged.onSessionStart({ sessionId: SID })).resolves.toBeUndefined();
    expect(() => merged.onExecutionChange()).not.toThrow();
    expect(warns).toContain("good ran"); // the good delegate still ran
    expect(warns.join("")).toMatch(/onSessionStart hook failed/);
    expect(warns.join("")).toMatch(/onExecutionChange hook failed/);
  });

  it("ignores null/undefined hook sets and end-to-end real factories compose", async () => {
    const { posts, fetchImpl } = fakeServer();
    const merged = mergeUploadHooks(
      null,
      createExecutionUploadHooks({
        url: "https://c",
        apiKey: "k",
        getConnectionUuid: () => "conn-1",
        getSnapshot: () => [],
        logger: silent,
        fetchImpl,
      }),
      createTranscriptUploadHooks({ url: "https://c", apiKey: "k", logger: silent, fetchImpl, batchDelayMs: 0 }),
      undefined,
      { logger: silent }
    );

    await merged.onSessionStart({ sessionId: SID, isNew: true });
    await merged.onTranscriptMessage({ sessionId: SID, message: ASSISTANT_TEXT });
    merged.onExecutionChange();
    // Let both the (microtask) transcript flush and the execution chain settle.
    await new Promise((r) => setTimeout(r, 5));

    const urls = posts.map((p) => p.url);
    expect(urls).toContain("https://c/api/daemon/transcript");
    expect(urls).toContain("https://c/api/daemon/execution-state");
  });
});

// ── Per-turn token usage capture (daemon-token-usage) ──
// Fixtures below are trimmed from a REAL `claude -p --output-format stream-json --verbose`
// capture (CLI 2.1.x, Bedrock): the `result` envelope's top-level `.model` is null and the
// model is only in `.modelUsage[<id>].canonicalModel`; token counts are snake_case on `.usage`.
const RESULT_WITH_USAGE = {
  type: "result",
  subtype: "success",
  session_id: SID,
  result: "done",
  model: null, // Bedrock: top-level model is null — must fall back to modelUsage
  usage: {
    input_tokens: 10,
    output_tokens: 214,
    cache_creation_input_tokens: 24701,
    cache_read_input_tokens: 0,
    service_tier: "standard",
  },
  modelUsage: {
    "claude-haiku-4-5-20251001": { canonicalModel: "claude-haiku-4-5", provider: "bedrock" },
  },
  total_cost_usd: 0.03195625,
};

describe("extractTurnUsage — normalize the Claude Code result envelope", () => {
  it("maps a full result envelope to the TokenUsage shape (tokens + canonical model, no cost)", () => {
    expect(extractTurnUsage(RESULT_WITH_USAGE)).toEqual({
      inputTokens: 10,
      outputTokens: 214,
      cacheCreationTokens: 24701,
      cacheReadTokens: 0,
      model: "claude-haiku-4-5",
      source: CLAUDE_CODE_USAGE_SOURCE,
    });
    // Tokens-only contract: no cost field leaks through even though the frame has one.
    expect(extractTurnUsage(RESULT_WITH_USAGE)).not.toHaveProperty("costUsd");
    expect(extractTurnUsage(RESULT_WITH_USAGE)).not.toHaveProperty("totalCostUsd");
  });

  it("prefers a non-empty top-level model over modelUsage", () => {
    const r = { ...RESULT_WITH_USAGE, model: "claude-opus-4-8" };
    expect(extractTurnUsage(r).model).toBe("claude-opus-4-8");
  });

  it("nulls absent token fields (partial usage — e.g. a backend with no cache-write)", () => {
    const r = { type: "result", session_id: SID, usage: { input_tokens: 5, output_tokens: 7 } };
    expect(extractTurnUsage(r)).toEqual({
      inputTokens: 5,
      outputTokens: 7,
      cacheCreationTokens: null,
      cacheReadTokens: null,
      model: null,
      source: CLAUDE_CODE_USAGE_SOURCE,
    });
  });

  it("coerces a garbled (string/negative/NaN) token count to null, never a bogus number", () => {
    const r = {
      type: "result",
      session_id: SID,
      usage: { input_tokens: "12", output_tokens: -3, cache_read_input_tokens: 1.9 },
    };
    const u = extractTurnUsage(r);
    expect(u.inputTokens).toBeNull(); // string → null
    expect(u.outputTokens).toBeNull(); // negative → null
    expect(u.cacheReadTokens).toBe(2); // 1.9 rounded
  });

  it("returns null for every non-result frame (transcript path untouched)", () => {
    expect(extractTurnUsage(ASSISTANT_TEXT)).toBeNull();
    expect(extractTurnUsage(ASSISTANT_THINKING)).toBeNull();
    expect(extractTurnUsage(SYSTEM_INIT)).toBeNull();
    expect(
      extractTurnUsage({
        type: "user",
        session_id: SID,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      }),
    ).toBeNull();
    // A result frame with no usage object is not usage-bearing.
    expect(extractTurnUsage(RESULT_ENVELOPE)).toBeNull();
  });

  it("never throws on a malformed / non-object input", () => {
    expect(extractTurnUsage(null)).toBeNull();
    expect(extractTurnUsage(undefined)).toBeNull();
    expect(extractTurnUsage("result")).toBeNull();
    expect(extractTurnUsage({ type: "result", usage: 42 })).toBeNull();
  });

  it("does NOT read the token counts from per-message assistant.usage (result is authoritative)", () => {
    // An assistant frame carries its own usage, but extractTurnUsage ignores it entirely.
    const assistantWithUsage = {
      type: "assistant",
      session_id: SID,
      message: { role: "assistant", model: "x", usage: { input_tokens: 999, output_tokens: 999 } },
    };
    expect(extractTurnUsage(assistantWithUsage)).toBeNull();
  });

  it("does NOT capture a Codex turn.completed frame (Claude extractor stays Claude-only)", () => {
    expect(extractTurnUsage(CODEX_TURN_COMPLETED_FULL)).toBeNull();
  });
});

// ── Real captured Codex `turn.completed` usage shape (codex-cli 0.145.0) ──
// Verified against a live `codex exec --json` run and ../codex/codex-rs/exec/src/exec_events.rs
// `Usage { input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens,
// reasoning_output_tokens }`. No model id appears on ANY Codex event. The older-CLI subset
// (0.142.3: only input_tokens + output_tokens) is covered by the pre-existing CODEX_TURN_COMPLETED.
const CODEX_TURN_COMPLETED_FULL = {
  type: "turn.completed",
  usage: {
    input_tokens: 13497,
    cached_input_tokens: 4096,
    cache_write_input_tokens: 512,
    output_tokens: 5,
    reasoning_output_tokens: 2000,
  },
};

describe("extractCodexTurnUsage — normalize the Codex turn.completed event", () => {
  it("maps a full codex-cli 0.145.0 turn.completed to the TokenUsage shape (output_tokens alone, model null)", () => {
    expect(extractCodexTurnUsage(CODEX_TURN_COMPLETED_FULL)).toEqual({
      inputTokens: 13497,
      outputTokens: 5, // output_tokens ALONE — reasoning_output_tokens is a subdivision inside it, not added
      cacheCreationTokens: 512, // ← cache_write_input_tokens
      cacheReadTokens: 4096, // ← cached_input_tokens
      model: null, // no model on the Codex stream
      source: CODEX_USAGE_SOURCE,
    });
    // Tokens-only contract: no cost / total_tokens leaks through.
    expect(extractCodexTurnUsage(CODEX_TURN_COMPLETED_FULL)).not.toHaveProperty("costUsd");
    expect(extractCodexTurnUsage(CODEX_TURN_COMPLETED_FULL)).not.toHaveProperty("totalTokens");
  });

  it("does NOT add reasoning_output_tokens to output_tokens (reasoning is a subdivision inside output — adding it double-counts)", () => {
    // Verified against ../codex/codex-rs: reasoning_output_tokens comes from
    // output_tokens_details.reasoning_tokens (a detail of output_tokens); the codex test
    // asserts input:100 + output:10 = total:110 with reasoning:5 already inside output.
    const r = { type: "turn.completed", usage: { input_tokens: 100, output_tokens: 5, reasoning_output_tokens: 2000 } };
    expect(extractCodexTurnUsage(r).outputTokens).toBe(5);
  });

  it("degrades gracefully on an older-CLI subset (no cache-write / no reasoning field)", () => {
    // CODEX_TURN_COMPLETED is the real 0.142.3 shape: only input_tokens + output_tokens.
    expect(extractCodexTurnUsage(CODEX_TURN_COMPLETED)).toEqual({
      inputTokens: 13714,
      outputTokens: 6, // output_tokens
      cacheCreationTokens: null, // cache_write_input_tokens absent
      cacheReadTokens: null, // cached_input_tokens absent
      model: null,
      source: CODEX_USAGE_SOURCE,
    });
  });

  it("nulls output when output_tokens is absent (no fabricated zero); reasoning alone does NOT stand in for output", () => {
    const r = { type: "turn.completed", usage: { input_tokens: 42 } };
    const u = extractCodexTurnUsage(r);
    expect(u.inputTokens).toBe(42);
    expect(u.outputTokens).toBeNull();
    // reasoning_output_tokens is NOT a source for outputTokens — only output_tokens is.
    expect(extractCodexTurnUsage({ type: "turn.completed", usage: { reasoning_output_tokens: 7 } }).outputTokens).toBeNull();
    expect(extractCodexTurnUsage({ type: "turn.completed", usage: { output_tokens: 9 } }).outputTokens).toBe(9);
  });

  it("coerces garbled counts to null (string/negative/float), never a bogus number", () => {
    const r = {
      type: "turn.completed",
      usage: {
        input_tokens: "12", // string → null
        output_tokens: -3, // negative → null
        cached_input_tokens: 1.4, // rounds to 1
        cache_write_input_tokens: -8, // negative → null
      },
    };
    const u = extractCodexTurnUsage(r);
    expect(u.inputTokens).toBeNull();
    expect(u.outputTokens).toBeNull(); // negative → null
    expect(u.cacheReadTokens).toBe(1);
    expect(u.cacheCreationTokens).toBeNull();
  });

  it("returns null for every non-turn.completed frame (transcript + Claude paths untouched)", () => {
    expect(extractCodexTurnUsage(CODEX_AGENT_MESSAGE)).toBeNull();
    expect(extractCodexTurnUsage(CODEX_THREAD_STARTED)).toBeNull();
    expect(extractCodexTurnUsage(CODEX_TURN_STARTED)).toBeNull();
    expect(extractCodexTurnUsage(CODEX_REASONING)).toBeNull();
    // A Claude result envelope is NOT a Codex frame — no cross-dialect capture.
    expect(extractCodexTurnUsage(RESULT_WITH_USAGE)).toBeNull();
    // A turn.completed with no usage object is not usage-bearing.
    expect(extractCodexTurnUsage({ type: "turn.completed" })).toBeNull();
  });

  it("never throws on a malformed / non-object input", () => {
    expect(extractCodexTurnUsage(null)).toBeNull();
    expect(extractCodexTurnUsage(undefined)).toBeNull();
    expect(extractCodexTurnUsage("turn.completed")).toBeNull();
    expect(extractCodexTurnUsage({ type: "turn.completed", usage: 42 })).toBeNull();
  });
});

describe("createTranscriptUploadHooks — onSessionEnd returns captured token usage", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("captures the result-frame usage and returns it from onSessionEnd", async () => {
    const { fetchImpl } = fakeServer();
    const hooks = createTranscriptUploadHooks({ url: "https://c", apiKey: "k", logger: silent, fetchImpl });
    await hooks.onSessionStart({ sessionId: SID, isNew: true });
    await hooks.onTranscriptMessage({ sessionId: SID, message: ASSISTANT_TEXT });
    await hooks.onTranscriptMessage({ sessionId: SID, message: RESULT_WITH_USAGE });
    const outcome = await hooks.onSessionEnd({ sessionId: SID });
    expect(outcome.usage).toEqual({
      inputTokens: 10,
      outputTokens: 214,
      cacheCreationTokens: 24701,
      cacheReadTokens: 0,
      model: "claude-haiku-4-5",
      source: CLAUDE_CODE_USAGE_SOURCE,
    });
    expect(outcome.relayError).toBeNull();
  });

  it("returns usage:null when the run emitted no result frame (no fabricated zeros)", async () => {
    const { fetchImpl } = fakeServer();
    const hooks = createTranscriptUploadHooks({ url: "https://c", apiKey: "k", logger: silent, fetchImpl });
    await hooks.onSessionStart({ sessionId: SID, isNew: true });
    await hooks.onTranscriptMessage({ sessionId: SID, message: ASSISTANT_TEXT });
    const outcome = await hooks.onSessionEnd({ sessionId: SID });
    expect(outcome.usage).toBeNull();
  });

  it("resets usage on a new wake so a later turn never inherits the prior turn's usage", async () => {
    const { fetchImpl } = fakeServer();
    const hooks = createTranscriptUploadHooks({ url: "https://c", apiKey: "k", logger: silent, fetchImpl });
    // First wake reports usage.
    await hooks.onSessionStart({ sessionId: SID, isNew: true });
    await hooks.onTranscriptMessage({ sessionId: SID, message: RESULT_WITH_USAGE });
    expect((await hooks.onSessionEnd({ sessionId: SID })).usage).not.toBeNull();
    // Second wake (same hook instance) reports NO result frame → usage must be null, not stale.
    await hooks.onSessionStart({ sessionId: SID, isNew: false });
    await hooks.onTranscriptMessage({ sessionId: SID, message: ASSISTANT_TEXT });
    expect((await hooks.onSessionEnd({ sessionId: SID })).usage).toBeNull();
  });

  it("captures a Codex turn.completed frame through the SAME capture site (source=codex)", async () => {
    const { fetchImpl } = fakeServer();
    const hooks = createTranscriptUploadHooks({ url: "https://c", apiKey: "k", logger: silent, fetchImpl });
    await hooks.onSessionStart({ sessionId: SID, isNew: true });
    // A codex agent_message (assistant text) then the turn.completed usage frame.
    await hooks.onTranscriptMessage({ sessionId: SID, message: CODEX_AGENT_MESSAGE });
    await hooks.onTranscriptMessage({ sessionId: SID, message: CODEX_TURN_COMPLETED_FULL });
    const outcome = await hooks.onSessionEnd({ sessionId: SID });
    expect(outcome.usage).toEqual({
      inputTokens: 13497,
      outputTokens: 5,
      cacheCreationTokens: 512,
      cacheReadTokens: 4096,
      model: null,
      source: CODEX_USAGE_SOURCE,
    });
    expect(outcome.relayError).toBeNull();
  });

  it("returns usage:null for a Codex stream that emitted no turn.completed (no fabricated zeros)", async () => {
    const { fetchImpl } = fakeServer();
    const hooks = createTranscriptUploadHooks({ url: "https://c", apiKey: "k", logger: silent, fetchImpl });
    await hooks.onSessionStart({ sessionId: SID, isNew: true });
    await hooks.onTranscriptMessage({ sessionId: SID, message: CODEX_AGENT_MESSAGE });
    expect((await hooks.onSessionEnd({ sessionId: SID })).usage).toBeNull();
  });
});

describe("mergeUploadHooks — aggregates usage independently of relayError", () => {
  it("surfaces the transcript hook's usage through the merged onSessionEnd", async () => {
    const { fetchImpl } = fakeServer();
    const transcript = createTranscriptUploadHooks({ url: "https://c", apiKey: "k", logger: silent, fetchImpl });
    const merged = mergeUploadHooks(transcript, createNoopUploadHooks(), { logger: silent });
    await merged.onSessionStart({ sessionId: SID, isNew: true });
    await merged.onTranscriptMessage({ sessionId: SID, message: RESULT_WITH_USAGE });
    const outcome = await merged.onSessionEnd({ sessionId: SID });
    expect(outcome.usage?.outputTokens).toBe(214);
    expect(outcome.relayError).toBeNull();
  });
});

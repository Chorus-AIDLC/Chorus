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

  it("an upload failure does not wedge the chain — a later batch still posts", async () => {
    let call = 0;
    const posts = [];
    const fetchImpl = vi.fn(async (url, init) => {
      call += 1;
      if (call === 1) throw new Error("boom");
      posts.push(JSON.parse(init.body));
      return { ok: true, status: 200, async json() { return {}; } };
    });
    const hooks = createTranscriptUploadHooks({ url: "https://c", apiKey: "k", logger: silent, fetchImpl });

    await hooks.onSessionStart({ sessionId: SID, isNew: true });
    await hooks.onTranscriptMessage({ sessionId: SID, message: ASSISTANT_TEXT });
    await vi.runAllTimersAsync();
    // Second turn/batch after the first failed.
    await hooks.onTranscriptMessage({ sessionId: SID, message: USER_TEXT_STRING });
    await vi.runAllTimersAsync();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(posts).toHaveLength(1);
    expect(posts[0].messages).toEqual([{ role: "user", text: "Please read /etc/hostname." }]);
  });
});

describe("mergeUploadHooks — compose execution + transcript concerns", () => {
  it("routes onSessionStart/onTranscriptMessage to transcript and onExecutionChange to execution", async () => {
    const calls = [];
    const transcript = {
      ...createNoopUploadHooks(),
      onSessionStart: async () => calls.push("ts:start"),
      onTranscriptMessage: async () => calls.push("ts:msg"),
    };
    const execution = {
      ...createNoopUploadHooks(),
      onExecutionChange: () => calls.push("ex:change"),
    };
    const merged = mergeUploadHooks(execution, transcript, { logger: silent });

    await merged.onSessionStart({ sessionId: SID });
    await merged.onTranscriptMessage({ sessionId: SID, message: ASSISTANT_TEXT });
    merged.onExecutionChange();

    expect(calls).toEqual(["ts:start", "ts:msg", "ex:change"]);
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

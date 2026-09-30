import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerEvents } from "../codex-app-server-events.mjs";
import { getCodexUsageSnapshot, setCodexUsageSnapshot } from "../codex-usage-map.mjs";
import { extractCodexTurnUsage, extractTranscriptText } from "../upload-hooks.mjs";

const threadId = "thread";
const turnId = "turn";
const item = (id, text, phase = "final_answer") => ({ id, type: "agentMessage", text, phase });
const frame = (method, params = {}) => ({ method, params: { threadId, turnId, ...params } });
const done = (status = "completed", items = []) => frame("turn/completed", { turn: { id: turnId, status, items } });
const usage = (inputTokens, outputTokens = 10, more = {}) => frame("thread/tokenUsage/updated", {
  tokenUsage: { total: { inputTokens, outputTokens, cachedInputTokens: 20, ...more },
    last: { inputTokens: 999999, outputTokens: 999999 } },
});
function setup(opts = {}) {
  const messages = [], snapshots = [];
  const adapter = new CodexAppServerEvents({
    threadId, isNew: true, onMessage: (m) => messages.push(m),
    onUsageSnapshot: (s) => snapshots.push(s), ...opts,
  });
  return { adapter, messages, snapshots };
}

describe("Codex App Server event bridge", () => {
  it("buffers completed events before turn/start response without trusting historical turn ids", async () => {
    const { adapter, messages } = setup();
    adapter.accept(frame("item/completed", { item: item("old", "history"), turnId: "old" }));
    adapter.accept(frame("turn/started", { turn: { id: turnId } }));
    adapter.accept(frame("item/agentMessage/delta", { delta: "hel", itemId: "a" }));
    adapter.accept(frame("item/completed", { item: item("a", "hello") }));
    adapter.accept(done());
    expect(messages).toEqual([]);
    expect(adapter.observedTurnId).toBe(turnId);
    adapter.confirmTurn(turnId);
    expect(await adapter.completion).toEqual({ status: "completed", turnId });
    expect(messages.map(extractTranscriptText).filter(Boolean)).toEqual([{ role: "assistant", text: "hello" }]);
    expect(adapter.outcome.status).toBe("completed");
  });

  it("delivers distinct commentary and final snapshots once and excludes reasoning/tools/other threads", () => {
    const { adapter, messages } = setup();
    adapter.confirmTurn(turnId);
    for (const value of [item("c", "checking", "commentary"), item("f", "answer"), item("f", "answer"),
      { id: "r", type: "reasoning", text: "private" }, { id: "tool", type: "commandExecution", text: "not text" }]) {
      adapter.accept(frame("item/completed", { item: value }));
    }
    expect(adapter.accept(frame("item/completed", { threadId: "another", item: item("x", "wrong") }))).toBe(false);
    expect(adapter.accept(frame("item/completed", { turnId: "another", item: item("x", "wrong") }))).toBe(false);
    expect(adapter.accept({ id: "response", result: {} })).toBe(false);
    adapter.accept(done("completed", [item("f", "answer"), item("tail", "terminal-only")]));
    adapter.accept(done());
    expect(messages.map(extractTranscriptText).filter(Boolean).map((m) => m.text)).toEqual(["checking", "answer", "terminal-only"]);
    expect(messages.filter((m) => m.type === "turn.completed")).toHaveLength(1);
  });

  it("subtracts the baseline from the final cumulative snapshot once, then excludes caches", () => {
    const { adapter, messages, snapshots } = setup({
      isNew: false, previousUsage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 5 },
    });
    adapter.confirmTurn(turnId);
    adapter.accept(usage(110, 6));
    adapter.accept(usage(120, 10, { cachedInputTokens: 24, reasoningOutputTokens: 3 }));
    adapter.accept(usage(120, 10, { cachedInputTokens: 24, reasoningOutputTokens: 3 }));
    adapter.accept(done());
    adapter.finish();
    expect(snapshots).toHaveLength(2);
    expect(messages.map(extractCodexTurnUsage).filter(Boolean)).toEqual([{
      inputTokens: 16, outputTokens: 5, cacheReadTokens: 4, cacheCreationTokens: null, model: null, source: "codex",
    }]);
    expect(adapter.usageSnapshot.input_tokens).toBe(120);
  });

  it("seeds an exec-era thread without a baseline and resumes from the observed total", () => {
    const first = setup({ isNew: false });
    first.adapter.confirmTurn(turnId);
    first.adapter.accept(usage(1000, 100));
    first.adapter.accept(done());
    expect(first.messages.map(extractCodexTurnUsage).filter(Boolean)).toEqual([]);
    const second = setup({ isNew: false, previousUsage: first.adapter.usageSnapshot });
    second.adapter.confirmTurn(turnId);
    second.adapter.accept(usage(1040, 108));
    second.adapter.accept(done());
    expect(second.messages.map(extractCodexTurnUsage).filter(Boolean)[0]).toMatchObject({ inputTokens: 40, outputTokens: 8 });
  });

  it.each(["failed", "interrupted"])("persists latest observed totals for a %s turn without historical recount", async (status) => {
    const { adapter, snapshots, messages } = setup();
    adapter.confirmTurn(turnId);
    adapter.accept(usage(100, 10));
    adapter.accept(done(status));
    expect((await adapter.completion).status).toBe(status);
    expect(snapshots[0]).toMatchObject({ input_tokens: 100, output_tokens: 10 });
    expect(messages.map(extractCodexTurnUsage).filter(Boolean)[0]).toMatchObject({ inputTokens: 80, outputTokens: 10 });
  });

  it("flushes partial totals exactly once on a transport failure", () => {
    const { adapter, messages } = setup();
    adapter.confirmTurn(turnId);
    adapter.accept(usage(100, 10));
    expect(adapter.finish().input_tokens).toBe(100);
    adapter.finish();
    expect(messages.filter((m) => m.type === "turn.completed")).toHaveLength(1);
    expect(adapter.outcome).toBeNull();
  });

  it("survives a fresh adapter/store reload after interruption", () => {
    const dir = mkdtempSync(join(tmpdir(), "chorus-app-server-usage-test-"));
    const deps = { path: join(dir, "usage.json") };
    try {
      const first = setup({ onUsageSnapshot: (s) => setCodexUsageSnapshot("anchor", threadId, s, deps) });
      first.adapter.confirmTurn(turnId);
      first.adapter.accept(usage(200, 30));
      first.adapter.accept(done("interrupted"));
      const resumed = setup({ isNew: false, previousUsage: getCodexUsageSnapshot("anchor", threadId, deps) });
      resumed.adapter.confirmTurn(turnId);
      resumed.adapter.accept(usage(240, 36));
      resumed.adapter.accept(done());
      expect(resumed.messages.map(extractCodexTurnUsage).filter(Boolean)[0]).toMatchObject({ inputTokens: 40, outputTokens: 6 });
      expect(getCodexUsageSnapshot("anchor", "replacement-thread", deps)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses zero for a new replacement thread instead of an old thread's baseline", () => {
    const { adapter, messages } = setup({ previousUsage: { input_tokens: 9999, output_tokens: 9999 } });
    adapter.confirmTurn(turnId);
    adapter.accept(usage(100, 10, { reasoningOutputTokens: 8 }));
    adapter.accept(done());
    expect(messages.map(extractCodexTurnUsage).filter(Boolean)[0]).toMatchObject({ inputTokens: 80, outputTokens: 10 });
  });

  it("omits regressing counters, including intra-turn regression, and re-seeds observed totals", () => {
    const { adapter, messages, snapshots } = setup({
      isNew: false, previousUsage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 50 },
    });
    adapter.confirmTurn(turnId);
    adapter.accept(usage(150, 70));
    adapter.accept(usage(130, 45));
    adapter.accept(done());
    expect(messages.map(extractCodexTurnUsage).filter(Boolean)[0]).toMatchObject({ inputTokens: null, outputTokens: null, cacheReadTokens: 0 });
    expect(snapshots.at(-1)).toMatchObject({ input_tokens: 130, output_tokens: 45 });
  });

  it("keeps absent, malformed and historical-only counters unknown", () => {
    const { adapter, messages } = setup({ isNew: false, previousUsage: { input_tokens: 100 } });
    adapter.confirmTurn(turnId);
    adapter.accept(usage(150, 40, { cacheWriteInputTokens: -1, reasoningOutputTokens: "garbled", cachedInputTokens: NaN }));
    adapter.accept(done());
    expect(messages.map(extractCodexTurnUsage).filter(Boolean)[0]).toEqual({
      inputTokens: 50, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, source: "codex", model: null,
    });
  });

  it("does not invent usage for missing snapshots or invalid events", () => {
    const { adapter, messages } = setup();
    adapter.confirmTurn(turnId);
    adapter.accept(frame("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: -1 } } }));
    adapter.accept(done());
    expect(adapter.usageSnapshot).toBeNull();
    expect(messages.map(extractCodexTurnUsage).filter(Boolean)).toEqual([]);
  });

  it("emits a continuity notice once as a separate assistant item", () => {
    const { adapter, messages } = setup();
    adapter.notice("History unavailable; continuing from Chorus context.");
    adapter.notice("duplicate");
    expect(messages).toHaveLength(1);
    expect(extractTranscriptText(messages[0]).text).toContain("History unavailable");
  });

  it("bounds pre-response buffering and item dedup memory", () => {
    const first = setup({ maxBufferedBytes: 10 });
    expect(() => first.adapter.accept(frame("item/completed", { item: item("a", "message") }))).toThrow("EVENT_BUFFER_LIMIT");
    const second = setup({ maxItems: 1 });
    second.adapter.confirmTurn(turnId);
    second.adapter.accept(frame("item/completed", { item: item("a", "message") }));
    expect(() => second.adapter.accept(frame("item/completed", { item: item("b", "another") }))).toThrow("ITEM_LIMIT");
  });

  it("counts only current-turn item notifications as ongoing progress", () => {
    const { adapter } = setup();
    adapter.confirmTurn(turnId);
    expect(adapter.accept(frame("item/commandExecution/outputDelta", { delta: "progress" }))).toBe(true);
    expect(adapter.accept(frame("item/commandExecution/outputDelta", { turnId: "old", delta: "progress" }))).toBe(false);
    expect(adapter.accept(frame("transport/ping"))).toBe(false);
    expect(() => adapter.accept(done("invalid"))).toThrow("INVALID_TURN_OUTCOME");
  });

  it("accepts schema-validated 0.157.1 event examples through the real bridge", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/codex-app-server/schema-examples-0.157.1.json", import.meta.url)));
    const notifications = fixture.examples.filter((e) => e.kind === "notification").map((e) => e.message);
    const terminal = notifications.find((m) => m.method === "turn/completed" && m.params.turn.status === "completed");
    const { adapter, messages } = setup({ threadId: terminal.params.threadId });
    for (const message of notifications) adapter.accept(message);
    adapter.confirmTurn(terminal.params.turn.id);
    expect(messages.map(extractTranscriptText).filter(Boolean).map((x) => x.text)).toEqual([
      "Synthetic public fixture text", "Synthetic public fixture text",
    ]);
    expect(messages.map(extractCodexTurnUsage).filter(Boolean)).toEqual([{
      inputTokens: 75, outputTokens: 30, cacheCreationTokens: 5, cacheReadTokens: 20, model: null, source: "codex",
    }]);
  });

  it("omits exclusive input too when its cache delta regresses", () => {
    const { adapter, messages } = setup({ isNew: false, previousUsage: {
      input_tokens: 100, cached_input_tokens: 20, output_tokens: 10,
    } });
    adapter.confirmTurn(turnId);
    adapter.accept(usage(150, 30, { cachedInputTokens: 10 }));
    adapter.accept(done());
    expect(messages.map(extractCodexTurnUsage).filter(Boolean)[0]).toMatchObject({
      inputTokens: null, cacheReadTokens: null, outputTokens: 20,
    });
  });

  it.each([undefined, -1, "invalid"])("retains regression evidence across an optional counter reported as %s", (missing) => {
    const { adapter, messages, snapshots } = setup({ isNew: false, previousUsage: {
      input_tokens: 1000, cached_input_tokens: 0, cache_write_input_tokens: 100, output_tokens: 10,
    } });
    adapter.confirmTurn(turnId);
    for (const [input, cache] of [[1200, 200], [1250, missing], [1300, 150]]) {
      adapter.accept(usage(input, 20, { cachedInputTokens: 0, cacheWriteInputTokens: cache }));
    }
    adapter.finish();
    expect(messages.map(extractCodexTurnUsage).filter(Boolean)[0]).toMatchObject({
      inputTokens: null, cacheCreationTokens: null, outputTokens: 10,
    });
    expect(snapshots.at(-1)).toMatchObject({ input_tokens: 1300, cache_write_input_tokens: 150 });
  });
});

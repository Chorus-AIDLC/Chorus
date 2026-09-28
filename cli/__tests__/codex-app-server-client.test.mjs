import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { readFileSync } from "node:fs";
import {
  APP_SERVER_DEFAULTS,
  CodexAppServerClient,
  CodexAppServerError,
  headlessResponseFor,
  isHistoryUnavailableError,
} from "../codex-app-server-client.mjs";

const clients = [];
const children = [];
function setup({ blocked = false, limits, onDiagnostic } = {}) {
  const child = new EventEmitter();
  const writes = [];
  const callbacks = [];
  child.stdin = new Writable({
    highWaterMark: blocked ? 1 : 65536,
    write(bytes, _encoding, callback) {
      writes.push(JSON.parse(bytes.toString()));
      if (blocked) callbacks.push(callback);
      else callback();
    },
  });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const client = new CodexAppServerClient(child, { limits, onDiagnostic });
  clients.push(client);
  children.push(child);
  return {
    child, client, writes, callbacks,
    send: (message) => child.stdout.write(`${JSON.stringify(message)}\n`),
  };
}
const flush = async () => {
  await new Promise(process.nextTick); // Real Writable callbacks use nextTick.
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const child of children.splice(0)) {
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    child.emit("close");
  }
  vi.useRealTimers();
});

describe("Codex App Server client", () => {
  it("replays sanitized real 0.157.1 handshake and classified resume error", async () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/codex-app-server/handshake-0.157.1.json", import.meta.url)));
    const { client, send, writes } = setup();
    const received = [];
    client.subscribe((m) => { received.push(m); });
    for (const entry of fixture.transcript) {
      if (entry.direction !== "client") continue;
      const { method, params, id } = entry.message;
      if (id === undefined) { await client.notify(method, params); continue; }
      const response = fixture.transcript.find((e) => e.direction === "server" && e.message.id === id).message;
      const pending = client.request(method, params);
      const outcome = pending.then((result) => ({ result }), (error) => ({ error }));
      await flush();
      const wireId = writes.at(-1).id;
      send({ ...response, id: wireId });
      const value = await outcome;
      if (response.error) {
        expect(value.error).toBeInstanceOf(CodexAppServerError);
        expect(value.error.rpcCode).toBe(response.error.code);
        expect(isHistoryUnavailableError(value.error, params.threadId)).toBe(method === "thread/resume");
      } else expect(value.result).toEqual(response.result);
    }
    expect(writes.map((w) => w.method)).toEqual(["initialize", "initialized", "thread/resume", "turn/interrupt", "initialize"]);
    expect(writes.every((w) => !Object.hasOwn(w, "jsonrpc"))).toBe(true);
    expect(client.pendingCount).toBe(0);
    expect(received).toHaveLength(4);
  });

  it("correlates out-of-order responses; numeric and string IDs remain distinct", async () => {
    const { client, send, writes } = setup();
    const first = client.request("first", {});
    const second = client.request("second", {});
    await flush();
    send({ id: 1, result: "unrelated" });
    send({ id: writes[1].id, result: "second" });
    send({ id: writes[0].id, result: "first" });
    expect(await first).toBe("first");
    expect(await second).toBe("second");
    send({ id: writes[0].id, result: "duplicate ignored" });
    expect(client.closed).toBe(false);
  });

  it("replays schema-validated event fixtures and matches negative response contracts", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/codex-app-server/schema-examples-0.157.1.json", import.meta.url)));
    const notifications = fixture.examples.filter((e) => e.kind === "notification").map((e) => e.message);
    const { child, client } = setup();
    const observed = [];
    client.subscribe((message) => { observed.push(message); });
    // Several complete frames in a single read, including all terminal statuses.
    child.stdout.write(notifications.map((m) => JSON.stringify(m)).join("\n") + "\n");
    expect(observed).toEqual(notifications);
    for (const example of fixture.examples.filter((e) => e.kind === "response" && !e.schema.startsWith("v2/"))) {
      expect(headlessResponseFor(example.method)).toEqual({ result: example.message.result });
    }
  });

  it("decodes every byte boundary, CRLF, multiple frames and split UTF-8", () => {
    const { child, client } = setup();
    const messages = [{ method: "item/agentMessage/delta", params: { delta: "你好🌏" } }, { method: "future/event" }];
    const observed = [];
    const unsubscribe = client.subscribe((message) => { observed.push(message); });
    const bytes = Buffer.from(messages.map((m) => JSON.stringify(m)).join("\r\n") + "\r\n");
    for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
    expect(observed).toEqual(messages);
    unsubscribe();
    child.stdout.write('{"method":"ignored"}\n');
    expect(observed).toHaveLength(2);
    expect(client.closed).toBe(false);
  });

  it("delivers early terminal and usage notifications raw before turn/start response", async () => {
    const { client, send, writes } = setup();
    const events = [];
    client.subscribe((message) => { events.push(message); });
    const turn = client.request("turn/start", { threadId: "thread", input: [{ type: "text", text: "fixture" }] });
    const completed = { method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", items: [], status: "completed" } } };
    send(completed);
    send({ id: writes[0].id, result: { turn: { id: "turn", status: "inProgress", items: [] } } });
    expect((await turn).turn.id).toBe("turn");
    expect(events[0]).toEqual(completed);
    expect(client.closed).toBe(false); // Semantic settlement is the adapter's job.
  });

  it("serializes writes and waits for callback plus drain", async () => {
    const { client, writes, callbacks } = setup({ blocked: true });
    const one = client.notify("one");
    const two = client.notify("two");
    expect(writes.map((w) => w.method)).toEqual(["one"]);
    callbacks.shift()();
    await one;
    expect(writes.map((w) => w.method)).toEqual(["one", "two"]);
    callbacks.shift()();
    await two;
  });

  it.each(["timeout", "abort", "close"])("discards queued turn/start on %s; late drain cannot execute it", async (reason) => {
    vi.useFakeTimers();
    const { client, child, writes, callbacks } = setup({ blocked: true });
    const blocker = client.notify("blocker").catch((e) => e);
    const controller = new AbortController();
    const turn = client.request("turn/start", { input: [{ type: "text", text: "secret prompt" }] }, {
      timeoutMs: 10, signal: controller.signal,
    }).catch((e) => e);
    expect(writes).toHaveLength(1);
    if (reason === "timeout") await vi.advanceTimersByTimeAsync(10);
    else if (reason === "abort") controller.abort("secret cancellation reason");
    else client.close();
    expect(await turn).toBeInstanceOf(CodexAppServerError);
    expect(await blocker).toBeInstanceOf(CodexAppServerError);
    callbacks.shift()();
    child.stdin.emit("drain");
    await flush();
    expect(writes.map((w) => w.method)).toEqual(["blocker"]);
    expect(client.pendingCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(child.stdin.listenerCount("drain")).toBe(0);
  });

  it.each(["initialize", "thread/start", "thread/resume", "turn/start", "other"])("uses injectable response deadline for %s without retries", async (method) => {
    vi.useFakeTimers();
    const { client, writes } = setup({ limits: {
      initializeTimeoutMs: 7, threadSetupTimeoutMs: 7, turnStartTimeoutMs: 7, requestTimeoutMs: 7,
    } });
    const response = client.request(method, {}).catch((e) => e);
    await vi.advanceTimersByTimeAsync(7);
    expect((await response).code).toBe("RESPONSE_TIMEOUT");
    expect(writes).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect((await client.failure).code).toBe("RESPONSE_TIMEOUT");
  });

  it("discards an already queued turn on fatal reverse request before flushing the negative reply", async () => {
    vi.useFakeTimers();
    const { client, child, writes, callbacks, send } = setup({ blocked: true });
    const blocker = client.notify("blocker");
    const turn = client.request("turn/start", { threadId: "thread", input: [] }).catch((e) => e);
    const queuedNotice = client.notify("queued-notification").catch((e) => e);
    send({ id: 123, method: "future/unsupported", params: {} });
    expect((await turn).code).toBe("HEADLESS_REQUEST_UNSUPPORTED");
    expect((await queuedNotice).code).toBe("HEADLESS_REQUEST_UNSUPPORTED");
    expect(client.pendingCount).toBe(0);
    await expect(client.notify("late-notification")).rejects.toMatchObject({ code: "HEADLESS_REQUEST_UNSUPPORTED" });
    callbacks.shift()();
    await blocker;
    await flush();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual({ id: 123, error: { code: -32601, message: "Method not supported" } });
    callbacks.shift()();
    expect((await client.failure).code).toBe("HEADLESS_REQUEST_UNSUPPORTED");
    child.stdin.emit("drain");
    await flush();
    expect(writes.some((w) => w.method === "turn/start")).toBe(false);
    expect(client.pendingCount).toBe(0);
    expect(child.stdin.listenerCount("drain")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds blocked notification writes and the outbound queue", async () => {
    vi.useFakeTimers();
    const { client } = setup({ blocked: true, limits: { writeTimeoutMs: 10 } });
    const write = client.notify("blocked").catch((e) => e);
    await vi.advanceTimersByTimeAsync(10);
    expect((await write).code).toBe("WRITE_TIMEOUT");
    expect(vi.getTimerCount()).toBe(0);
    const bounded = setup({ blocked: true, limits: { maxQueuedBytes: 50 } });
    const one = bounded.client.notify("first").catch((e) => e);
    const two = bounded.client.notify("second", { data: "x".repeat(40) }).catch((e) => e);
    expect((await two).code).toBe("WRITE_BUFFER_LIMIT");
    expect((await one).code).toBe("WRITE_BUFFER_LIMIT");
    expect(bounded.writes).toHaveLength(1);
  });

  it("bounds pending requests", async () => {
    const { client } = setup({ limits: { maxPendingRequests: 1 } });
    const one = client.request("one").catch((e) => e);
    const two = client.request("two").catch((e) => e);
    expect((await one).code).toBe("PENDING_LIMIT");
    expect((await two).code).toBe("PENDING_LIMIT");
  });

  it("does not send a pre-aborted request and releases abort subscriptions on response", async () => {
    const first = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(first.client.request("turn/start", {}, { signal: controller.signal }))
      .rejects.toMatchObject({ code: "CANCELLED" });
    expect(first.writes).toHaveLength(0);
    const { client, send, writes } = setup();
    const active = new AbortController();
    const removed = vi.spyOn(active.signal, "removeEventListener");
    const response = client.request("one", {}, { signal: active.signal });
    send({ id: writes[0].id, result: {} });
    await response;
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
    active.abort();
    expect(client.closed).toBe(false);
  });

  it("contains synchronous stdin write failures", async () => {
    const { child, client } = setup();
    child.stdin.write = () => { throw Object.assign(new Error("private payload"), { code: "EPIPE" }); };
    await expect(client.request("turn/start", {})).rejects.toMatchObject({ code: "IO_ERROR" });
    expect(client.pendingCount).toBe(0);
  });

  it.each([
    ["not json\n", "MALFORMED_FRAME"],
    ["[]\n", "MALFORMED_FRAME"],
    ["null\n", "MALFORMED_FRAME"],
    ['{"id":null,"result":{}}\n', "MALFORMED_FRAME"],
    ['{"id":1,"error":{"code":"bad","message":"secret"}}\n', "MALFORMED_FRAME"],
    ['{"id":1,"result":{},"error":{"code":1,"message":"secret"}}\n', "MALFORMED_FRAME"],
    ['{"method":"bad","result":{}}\n', "MALFORMED_FRAME"],
    [Buffer.from([0xff, 10]), "MALFORMED_FRAME"],
    ["x".repeat(65), "FRAME_LIMIT"],
    ["x".repeat(65) + "\n", "FRAME_LIMIT"],
  ])("fails bounded malformed input %# without exposing input", async (bytes, code) => {
    const diagnostics = [];
    const { client, child } = setup({ limits: { maxFrameBytes: 64 }, onDiagnostic: (text) => diagnostics.push(text) });
    // Short enough to fit the outbound test frame.
    const pending = client.request("a").catch((e) => e);
    child.stdout.write(bytes);
    expect((await pending).code).toBe(code);
    expect(client.pendingCount).toBe(0);
    expect(diagnostics.join(" ")).not.toContain("secret");
    expect(child.stdout.listenerCount("data")).toBe(0);
  });

  it("accepts exactly maxFrameBytes and bounds stderr without logging it", () => {
    const diagnostics = [];
    const { client, child } = setup({ limits: { maxFrameBytes: 16, stderrTailBytes: 8 }, onDiagnostic: (s) => diagnostics.push(s) });
    child.stdout.write('{"method":"abc"}\n');
    expect(client.closed).toBe(false);
    child.stderr.write("secret credentials ".repeat(1000));
    expect(client.stderrBytes).toBe(8);
    child.stderr.write("abc");
    expect(client.stderrBytes).toBe(8);
    client.close();
    expect(client.stderrBytes).toBe(0);
    expect(diagnostics).toEqual(["Codex App Server: CLOSED"]);
  });

  it.each(["end", "truncated", "stdout-close", "stdin-close", "child-close", "error", "EPIPE"])("rejects all pending work on %s and tears down listeners", async (kind) => {
    vi.useFakeTimers();
    const { child, client, callbacks } = setup({ blocked: true });
    const one = client.request("one").catch((e) => e);
    const two = client.request("two").catch((e) => e);
    if (kind === "truncated") { child.stdout.write('{"id":'); child.stdout.emit("end"); }
    else if (kind === "stdout-close") child.stdout.emit("close");
    else if (kind === "stdin-close") child.stdin.emit("close");
    else if (kind === "child-close") child.emit("close");
    else if (kind === "error") child.emit("error", new Error("secret"));
    else if (kind === "EPIPE") callbacks.shift()(Object.assign(new Error("secret"), { code: "EPIPE" }));
    else child.stdout.emit("end");
    const failure = await client.failure;
    expect(await one).toBe(failure);
    expect(await two).toBe(failure);
    expect(client.pendingCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
    expect(child.stdin.listenerCount("drain")).toBe(0);
    client.close();
  });

  it("allows exit-before-close trailing data and guards late error events after close", async () => {
    const { child, client, send, writes } = setup();
    const pending = client.request("one");
    child.emit("exit", 0);
    send({ id: writes[0].id, result: 42 });
    expect(await pending).toBe(42);
    client.close();
    expect(() => child.stdin.emit("error", new Error("late EPIPE"))).not.toThrow();
    for (const emitter of [child, child.stdin, child.stdout, child.stderr]) {
      emitter.emit("close");
      expect(emitter.listenerCount("error")).toBe(0);
    }
  });

  it.each([
    ["item/commandExecution/requestApproval", { decision: "cancel" }],
    ["item/fileChange/requestApproval", { decision: "cancel" }],
    ["item/permissions/requestApproval", { permissions: {}, scope: "turn" }],
    ["mcpServer/elicitation/request", { action: "cancel", content: null }],
    ["execCommandApproval", { decision: "abort" }],
    ["applyPatchApproval", { decision: "abort" }],
    ["item/tool/call", { contentItems: [], success: false }],
  ])("sends safe headless response for %s, echoes numeric request ID", async (method, result) => {
    const { client, send, writes } = setup();
    send({ id: 123, method, params: { secret: "do not log" } });
    await flush();
    expect(writes).toEqual([{ id: 123, result }]);
    expect(headlessResponseFor(method)).toEqual({ result });
    expect(client.closed).toBe(false);
  });

  it.each(["unknown/method", "item/tool/requestUserInput", "account/chatgptAuthTokens/refresh", "attestation/generate"])("responds then fails unsupported headless %s", async (method) => {
    const { client, send, writes } = setup();
    send({ id: "server-id", method, params: { questions: ["secret question"] } });
    expect((await client.failure).code).toBe("HEADLESS_REQUEST_UNSUPPORTED");
    expect(writes).toEqual([{ id: "server-id", error: {
      code: method === "unknown/method" ? -32601 : -32603,
      message: method === "unknown/method" ? "Method not supported" : "Unavailable in headless mode",
    } }]);
  });

  it("bounds unknown-request response when stdin is blocked", async () => {
    vi.useFakeTimers();
    const { client, send } = setup({ blocked: true, limits: { writeTimeoutMs: 9 } });
    send({ id: 1, method: "unknown", params: {} });
    const rejected = client.request("turn/start").catch((e) => e);
    expect((await rejected).code).toBe("HEADLESS_REQUEST_UNSUPPORTED");
    await vi.advanceTimersByTimeAsync(9);
    expect((await client.failure).code).toBe("WRITE_TIMEOUT");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not classify generic RPC/provider/transport errors as history loss or log raw data", async () => {
    const diagnostics = [];
    const { client, send, writes } = setup({ onDiagnostic: (s) => diagnostics.push(s) });
    const rpc = client.request("thread/resume", { threadId: "thread", prompt: "private prompt" }).catch((e) => e);
    send({ id: writes[0].id, error: { code: -32600, message: "private provider credential", data: { secret: "key" } } });
    const error = await rpc;
    expect(isHistoryUnavailableError(error, "thread")).toBe(false);
    expect(isHistoryUnavailableError(new Error("no rollout found for thread id thread"), "thread")).toBe(false);
    expect(JSON.stringify(error)).not.toMatch(/private|secret|key/);
    expect(String(error)).not.toContain("private");
    client.close();
    expect(diagnostics.join(" ")).not.toMatch(/private|secret|key/);
  });

  it("settles subscriber failures without unhandled rejections", async () => {
    const { client, send } = setup({ onDiagnostic: async () => { throw new Error("private diagnostic"); } });
    client.subscribe(async () => { throw new Error("private listener"); });
    send({ method: "progress" });
    expect((await client.failure).code).toBe("SUBSCRIBER_ERROR");
  });

  it("rejects invalid outbound data with typed errors and rejects calls after close", async () => {
    const { client } = setup();
    await expect(client.respond(null, { result: {} })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(client.respond(1, { result: undefined })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(client.request("a", {}, { timeoutMs: 0 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(client.notify("", {})).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const circular = {}; circular.self = circular;
    await expect(client.notify("a", circular)).rejects.toMatchObject({ code: "INVALID_OUTBOUND_FRAME" });
    await expect(client.request("turn/start", {})).rejects.toBe(client.error);
    expect(() => new CodexAppServerClient({}, {})).toThrow(CodexAppServerError);
    expect(APP_SERVER_DEFAULTS.maxFrameBytes).toBe(32 * 1024 * 1024);
  });
});

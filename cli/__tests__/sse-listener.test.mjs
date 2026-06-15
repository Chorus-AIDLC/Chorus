// cli/__tests__/sse-listener.test.mjs
// Covers cli-daemon spec "Daemon subcommand and notification subscription"
// (SSE parsing) and the backoff/reconnect behavior.
import { describe, it, expect, vi } from "vitest";
import { SseListener } from "../sse-listener.mjs";

/** Build a fetch Response whose body streams the given chunks then ends. */
function streamingResponse(chunks, { ok = true, status = 200 } = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return { ok, status, body };
}

const silentLogger = { info() {}, warn() {}, error() {} };

describe("SseListener parsing", () => {
  it("parses data: lines as JSON and ignores heartbeats", async () => {
    const events = [];
    const fetchImpl = vi.fn(async () =>
      streamingResponse([
        ": connected\n\n",
        'data: {"type":"new_notification","notificationUuid":"n1"}\n\n',
        ": heartbeat\n\n",
        'data: {"type":"count_update","unreadCount":3}\n\n',
      ])
    );
    const listener = new SseListener({
      url: "https://chorus.example/",
      apiKey: "cho_x",
      onEvent: (e) => events.push(e),
      logger: silentLogger,
      fetchImpl,
    });

    await listener.connect();
    // Give the stream consumer a tick to drain.
    await new Promise((r) => setTimeout(r, 10));

    expect(events).toEqual([
      { type: "new_notification", notificationUuid: "n1" },
      { type: "count_update", unreadCount: 3 },
    ]);
    // Sent Bearer auth to the right endpoint
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://chorus.example/api/events/notifications",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer cho_x" }) })
    );
  });

  it("strips trailing CR so CRLF transports parse", async () => {
    const events = [];
    const fetchImpl = vi.fn(async () =>
      streamingResponse(['data: {"type":"x","v":1}\r\n\r\n'])
    );
    const listener = new SseListener({
      url: "https://c",
      apiKey: "k",
      onEvent: (e) => events.push(e),
      logger: silentLogger,
      fetchImpl,
    });
    await listener.connect();
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual([{ type: "x", v: 1 }]);
  });

  it("tolerates malformed data line without throwing", async () => {
    const events = [];
    const warns = [];
    const fetchImpl = vi.fn(async () =>
      streamingResponse(["data: {not json}\n\n", 'data: {"ok":true}\n\n'])
    );
    const listener = new SseListener({
      url: "https://c",
      apiKey: "k",
      onEvent: (e) => events.push(e),
      logger: { ...silentLogger, warn: (m) => warns.push(m) },
      fetchImpl,
    });
    await listener.connect();
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual([{ ok: true }]);
    expect(warns.join("")).toMatch(/parse error/i);
  });
});

describe("SseListener reconnect", () => {
  it("schedules a backoff reconnect on non-ok response without crashing", async () => {
    vi.useFakeTimers();
    let call = 0;
    const events = [];
    const fetchImpl = vi.fn(async () => {
      call++;
      if (call === 1) return { ok: false, status: 503, body: null };
      return streamingResponse(['data: {"type":"after_reconnect"}\n\n']);
    });
    const listener = new SseListener({
      url: "https://c",
      apiKey: "k",
      onEvent: (e) => events.push(e),
      logger: silentLogger,
      fetchImpl,
      initialDelayMs: 1000,
    });

    await listener.connect();
    expect(listener.status).toBe("reconnecting");
    expect(call).toBe(1);

    // Advance past the 1s backoff → second connect fires.
    await vi.advanceTimersByTimeAsync(1000);
    expect(call).toBe(2);

    vi.useRealTimers();
    listener.disconnect();
  });

  it("fires onReconnect after a successful reconnect", async () => {
    vi.useFakeTimers();
    let call = 0;
    const onReconnect = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => {
      call++;
      if (call === 1) return { ok: false, status: 500, body: null };
      return streamingResponse([": hb\n\n"]);
    });
    const listener = new SseListener({
      url: "https://c",
      apiKey: "k",
      onEvent: () => {},
      onReconnect,
      logger: silentLogger,
      fetchImpl,
      initialDelayMs: 500,
    });

    await listener.connect(); // fails → reconnecting
    await vi.advanceTimersByTimeAsync(500); // reconnect succeeds
    await vi.advanceTimersByTimeAsync(0);

    expect(onReconnect).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    listener.disconnect();
  });

  it("disconnect() aborts and does not reconnect", async () => {
    const fetchImpl = vi.fn(
      (url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        })
    );
    const listener = new SseListener({
      url: "https://c",
      apiKey: "k",
      onEvent: () => {},
      logger: silentLogger,
      fetchImpl,
    });
    const p = listener.connect();
    listener.disconnect();
    await p;
    expect(listener.status).toBe("disconnected");
  });
});

// cli/__tests__/sse-listener.test.mjs
// Covers cli-daemon spec "Daemon subcommand and notification subscription"
// (SSE parsing), the backoff/reconnect behavior, and the self-report query
// params the listener appends to the notification SSE URL.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SseListener } from "../sse-listener.mjs";

// The version the listener self-reports comes from the chorus CLI's own
// package.json (one level above cli/) — assert against that same source rather
// than a hardcoded literal, so a version bump doesn't break the test.
const CLI_VERSION = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8")
).version;

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
    // Sent Bearer auth to the notification endpoint (now carrying self-report
    // query params — assert the path + Bearer header, params covered below).
    const [calledUrl, calledInit] = fetchImpl.mock.calls[0];
    expect(calledUrl).toMatch(
      /^https:\/\/chorus\.example\/api\/events\/notifications\?/
    );
    expect(calledInit.headers).toMatchObject({ Authorization: "Bearer cho_x" });
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

  it("captures connection_registered as the connectionUuid and does NOT forward it as an event", async () => {
    const events = [];
    const connIds = [];
    const fetchImpl = vi.fn(async () =>
      streamingResponse([
        ": connected\n\n",
        'data: {"type":"connection_registered","connectionUuid":"conn-42"}\n\n',
        'data: {"type":"new_notification","notificationUuid":"n1"}\n\n',
      ])
    );
    const listener = new SseListener({
      url: "https://c",
      apiKey: "k",
      onEvent: (e) => events.push(e),
      onConnectionId: (id) => connIds.push(id),
      logger: silentLogger,
      fetchImpl,
    });
    await listener.connect();
    await new Promise((r) => setTimeout(r, 10));

    // The connection_registered event is captured, not delivered as a notification.
    expect(connIds).toEqual(["conn-42"]);
    expect(listener.connectionUuid).toBe("conn-42");
    expect(events).toEqual([{ type: "new_notification", notificationUuid: "n1" }]);
    listener.disconnect();
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

describe("SseListener self-report URL", () => {
  /** Capture the URL passed to fetch on connect. */
  function captureUrl(listenerOpts = {}) {
    const fetchImpl = vi.fn(async () =>
      streamingResponse([": connected\n\n"])
    );
    const listener = new SseListener({
      url: "https://chorus.example/",
      apiKey: "cho_x",
      onEvent: () => {},
      logger: silentLogger,
      fetchImpl,
      ...listenerOpts,
    });
    return { listener, fetchImpl };
  }

  it("appends clientType=claude_code + version + host + startedAt", async () => {
    const { listener, fetchImpl } = captureUrl();
    await listener.connect();

    const url = new URL(fetchImpl.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe(
      "https://chorus.example/api/events/notifications"
    );
    expect(url.searchParams.get("clientType")).toBe("claude_code");
    // Version is the CLI's real package version, not a hardcoded literal.
    expect(url.searchParams.get("clientVersion")).toBe(CLI_VERSION);
    expect(url.searchParams.get("host")).toBe(hostname());
    // startedAt is a valid ISO-8601 timestamp.
    const startedAt = url.searchParams.get("startedAt");
    expect(startedAt).toBeTruthy();
    expect(Number.isNaN(Date.parse(startedAt))).toBe(false);
    expect(new Date(startedAt).toISOString()).toBe(startedAt);

    listener.disconnect();
  });

  it("re-sends the same self-report params on reconnect", async () => {
    vi.useFakeTimers();
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call++;
      if (call === 1) return { ok: false, status: 503, body: null };
      return streamingResponse([": connected\n\n"]);
    });
    const listener = new SseListener({
      url: "https://chorus.example/",
      apiKey: "cho_x",
      onEvent: () => {},
      logger: silentLogger,
      fetchImpl,
      initialDelayMs: 1000,
    });

    await listener.connect(); // first attempt → reconnecting
    await vi.advanceTimersByTimeAsync(1000); // reconnect fires

    expect(call).toBe(2);
    const firstUrl = fetchImpl.mock.calls[0][0];
    const secondUrl = fetchImpl.mock.calls[1][0];
    // The reconnect re-sends the byte-identical URL (params included).
    expect(secondUrl).toBe(firstUrl);
    const u = new URL(secondUrl);
    expect(u.searchParams.get("clientType")).toBe("claude_code");
    expect(u.searchParams.get("clientVersion")).toBe(CLI_VERSION);

    vi.useRealTimers();
    listener.disconnect();
  });

  it("keeps the Bearer header and Accept header on the self-reporting request", async () => {
    const { listener, fetchImpl } = captureUrl({ apiKey: "cho_secret" });
    await listener.connect();
    const init = fetchImpl.mock.calls[0][1];
    expect(init.headers).toMatchObject({
      Authorization: "Bearer cho_secret",
      Accept: "text/event-stream",
    });
    listener.disconnect();
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

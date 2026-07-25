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
    expect(new URL(calledUrl).searchParams.get("livenessAck")).toBe("v1");
  });

  it("acknowledges heartbeat comments only after a generation-bearing registration", async () => {
    const events = [];
    const acknowledgeHeartbeat = vi.fn(async () => ({ ok: true, status: 200 }));
    const fetchImpl = vi.fn(async () =>
      streamingResponse([
        ": heartbeat\n\n",
        'data: {"type":"connection_registered","connectionUuid":"conn-42","connectedAt":"2026-07-25T08:00:00.000Z"}\n\n',
        ": heartbeat\n\n",
      ])
    );
    const listener = new SseListener({
      url: "https://c",
      apiKey: "k",
      onEvent: (event) => events.push(event),
      acknowledgeHeartbeat,
      logger: silentLogger,
      fetchImpl,
    });

    await listener.connect();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(acknowledgeHeartbeat).toHaveBeenCalledTimes(1);
    expect(acknowledgeHeartbeat).toHaveBeenCalledWith({
      connectionUuid: "conn-42",
      connectedAt: "2026-07-25T08:00:00.000Z",
    });
    expect(events).toEqual([]);
    listener.disconnect();
  });

  it("logs a thrown heartbeat acknowledgment failure without stopping parsing", async () => {
    const warns = [];
    const events = [];
    const fetchImpl = vi.fn(async () =>
      streamingResponse([
        'data: {"type":"connection_registered","connectionUuid":"c","connectedAt":"g"}\n\n',
        ": heartbeat\n\n",
        'data: {"type":"new_notification","notificationUuid":"after"}\n\n',
      ])
    );
    const listener = new SseListener({
      url: "https://c",
      apiKey: "k",
      onEvent: (event) => events.push(event),
      acknowledgeHeartbeat: async () => { throw new Error("offline"); },
      logger: { ...silentLogger, warn: (message) => warns.push(message) },
      fetchImpl,
    });

    await listener.connect();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(events).toEqual([{ type: "new_notification", notificationUuid: "after" }]);
    expect(warns.join(" ")).toMatch(/heartbeat acknowledgment failed.*offline/);
    listener.disconnect();
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

  it("forks a type:control event to onControl and NEVER to onEvent (子3 — zero wakes)", async () => {
    const events = [];
    const controls = [];
    const fetchImpl = vi.fn(async () =>
      streamingResponse([
        ": connected\n\n",
        'data: {"type":"connection_registered","connectionUuid":"conn-7"}\n\n',
        'data: {"type":"control","command":"interrupt","targetConnectionUuid":"conn-7","entityType":"task","entityUuid":"task-1"}\n\n',
        'data: {"type":"new_notification","notificationUuid":"n1"}\n\n',
      ])
    );
    const listener = new SseListener({
      url: "https://c",
      apiKey: "k",
      onEvent: (e) => events.push(e),
      onControl: (e) => controls.push(e),
      logger: silentLogger,
      fetchImpl,
    });
    await listener.connect();
    await new Promise((r) => setTimeout(r, 10));

    // The control event went to onControl ONLY.
    expect(controls).toEqual([
      { type: "control", command: "interrupt", targetConnectionUuid: "conn-7", entityType: "task", entityUuid: "task-1" },
    ]);
    // onEvent saw the real notification but NEVER the control event (no wake path).
    expect(events).toEqual([{ type: "new_notification", notificationUuid: "n1" }]);
    listener.disconnect();
  });

  it("a throwing onControl callback does not crash the stream", async () => {
    const warns = [];
    const events = [];
    const fetchImpl = vi.fn(async () =>
      streamingResponse([
        'data: {"type":"control","command":"interrupt","targetConnectionUuid":"c","entityType":"task","entityUuid":"t"}\n\n',
        'data: {"type":"new_notification","notificationUuid":"after"}\n\n',
      ])
    );
    const listener = new SseListener({
      url: "https://c",
      apiKey: "k",
      onEvent: (e) => events.push(e),
      onControl: () => { throw new Error("handler boom"); },
      logger: { ...silentLogger, warn: (m) => warns.push(m) },
      fetchImpl,
    });
    await listener.connect();
    await new Promise((r) => setTimeout(r, 10));
    // The next event still flows despite the throwing control handler.
    expect(events).toEqual([{ type: "new_notification", notificationUuid: "after" }]);
    expect(warns.join("")).toMatch(/onControl callback error/);
    listener.disconnect();
  });

  it("forks a type:connection_conflict event to onConflict and NEVER to onEvent (no wake)", async () => {
    const events = [];
    const conflicts = [];
    const fetchImpl = vi.fn(async () =>
      streamingResponse([
        ": connected\n\n",
        'data: {"type":"connection_conflict","host":"mac.local","cwd":"/work/alpha"}\n\n',
        'data: {"type":"new_notification","notificationUuid":"n1"}\n\n',
      ])
    );
    const listener = new SseListener({
      url: "https://c",
      apiKey: "k",
      onEvent: (e) => events.push(e),
      onConflict: (e) => conflicts.push(e),
      logger: silentLogger,
      fetchImpl,
    });
    await listener.connect();
    await new Promise((r) => setTimeout(r, 10));

    // The conflict event went to onConflict ONLY, carrying host + cwd.
    expect(conflicts).toEqual([
      { type: "connection_conflict", host: "mac.local", cwd: "/work/alpha" },
    ]);
    // onEvent saw the real notification but NEVER the conflict event (no wake path).
    expect(events).toEqual([{ type: "new_notification", notificationUuid: "n1" }]);
    listener.disconnect();
  });

  it("a throwing onConflict callback does not crash the stream", async () => {
    const warns = [];
    const events = [];
    const fetchImpl = vi.fn(async () =>
      streamingResponse([
        'data: {"type":"connection_conflict","host":"h","cwd":"/w"}\n\n',
        'data: {"type":"new_notification","notificationUuid":"after"}\n\n',
      ])
    );
    const listener = new SseListener({
      url: "https://c",
      apiKey: "k",
      onEvent: (e) => events.push(e),
      onConflict: () => { throw new Error("conflict boom"); },
      logger: { ...silentLogger, warn: (m) => warns.push(m) },
      fetchImpl,
    });
    await listener.connect();
    await new Promise((r) => setTimeout(r, 10));
    // The next event still flows despite the throwing conflict handler.
    expect(events).toEqual([{ type: "new_notification", notificationUuid: "after" }]);
    expect(warns.join("")).toMatch(/onConflict callback error/);
    listener.disconnect();
  });

  it("defaults onConflict to a no-op: a connection_conflict with no handler does not crash or reach onEvent", async () => {
    const events = [];
    const fetchImpl = vi.fn(async () =>
      streamingResponse([
        'data: {"type":"connection_conflict","host":"h","cwd":"/w"}\n\n',
        'data: {"type":"new_notification","notificationUuid":"n1"}\n\n',
      ])
    );
    // No onConflict supplied → constructor defaults it to a no-op.
    const listener = new SseListener({
      url: "https://c",
      apiKey: "k",
      onEvent: (e) => events.push(e),
      logger: silentLogger,
      fetchImpl,
    });
    await listener.connect();
    await new Promise((r) => setTimeout(r, 10));
    // Conflict is swallowed by the default no-op; only the real notification reaches onEvent.
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

  it("appends clientType=claude_code + version + host + cwd + startedAt", async () => {
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
    // cwd is the working directory this connection serves — the CLI is single-cwd
    // today so it reports process.cwd(). The server keys the registry on it so
    // same agent + same host + different cwd no longer overwrite each other.
    expect(url.searchParams.get("cwd")).toBe(process.cwd());
    // startedAt is a valid ISO-8601 timestamp.
    const startedAt = url.searchParams.get("startedAt");
    expect(startedAt).toBeTruthy();
    expect(Number.isNaN(Date.parse(startedAt))).toBe(false);
    expect(new Date(startedAt).toISOString()).toBe(startedAt);

    listener.disconnect();
  });

  it("defaults clientType to claude_code when none is given", async () => {
    const { listener, fetchImpl } = captureUrl();
    await listener.connect();
    const url = new URL(fetchImpl.mock.calls[0][0]);
    expect(url.searchParams.get("clientType")).toBe("claude_code");
    listener.disconnect();
  });

  it("reports clientType=codex when constructed for the codex backend", async () => {
    const { listener, fetchImpl } = captureUrl({ clientType: "codex" });
    await listener.connect();
    const url = new URL(fetchImpl.mock.calls[0][0]);
    expect(url.searchParams.get("clientType")).toBe("codex");
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
  function controlledResponse() {
    let controller;
    const body = new ReadableStream({
      start(value) {
        controller = value;
      },
    });
    return {
      response: { ok: true, status: 200, body },
      push(text) {
        controller.enqueue(new TextEncoder().encode(text));
      },
      close() {
        controller.close();
      },
    };
  }

  it("aborts a byte-silent stream and reconnects through the existing backfill path", async () => {
    vi.useFakeTimers();
    const first = controlledResponse();
    const second = controlledResponse();
    const signals = [];
    const onReconnect = vi.fn(async () => {});
    const fetchImpl = vi.fn(async (_url, init) => {
      signals.push(init.signal);
      return signals.length === 1 ? first.response : second.response;
    });
    const listener = new SseListener({
      url: "https://c",
      apiKey: "k",
      onEvent: () => {},
      onReconnect,
      logger: silentLogger,
      fetchImpl,
      watchdogTimeoutMs: 75_000,
      initialDelayMs: 1_000,
    });

    await listener.connect();
    await vi.advanceTimersByTimeAsync(75_000);
    expect(signals[0].aborted).toBe(true);
    expect(listener.status).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onReconnect).toHaveBeenCalledTimes(1);

    listener.disconnect();
    vi.useRealTimers();
  });

  it("refreshes the watchdog on partial bytes before an SSE frame can be parsed", async () => {
    vi.useFakeTimers();
    const stream = controlledResponse();
    const fetchImpl = vi.fn(async () => stream.response);
    const listener = new SseListener({
      url: "https://c",
      apiKey: "k",
      onEvent: () => {},
      logger: silentLogger,
      fetchImpl,
      watchdogTimeoutMs: 75_000,
    });

    await listener.connect();
    await vi.advanceTimersByTimeAsync(74_000);
    stream.push("data: {");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(74_000);
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);

    listener.disconnect();
    vi.useRealTimers();
  });

  it("disconnect clears the watchdog so it cannot schedule a later reconnect", async () => {
    vi.useFakeTimers();
    const stream = controlledResponse();
    const fetchImpl = vi.fn(async () => stream.response);
    const listener = new SseListener({
      url: "https://c",
      apiKey: "k",
      onEvent: () => {},
      logger: silentLogger,
      fetchImpl,
      watchdogTimeoutMs: 100,
      initialDelayMs: 10,
    });

    await listener.connect();
    listener.disconnect();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(listener.status).toBe("disconnected");
    vi.useRealTimers();
  });

  it("an obsolete watchdog cannot abort its replacement stream or schedule a duplicate reconnect", async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const first = controlledResponse();
    const replacement = controlledResponse();
    const signals = [];
    const fetchImpl = vi.fn(async (_url, init) => {
      signals.push(init.signal);
      return signals.length === 1 ? first.response : replacement.response;
    });
    const listener = new SseListener({
      url: "https://c",
      apiKey: "k",
      onEvent: () => {},
      logger: silentLogger,
      fetchImpl,
      watchdogTimeoutMs: 100,
      initialDelayMs: 10,
    });

    await listener.connect();
    const obsoleteWatchdog = timeoutSpy.mock.calls.find(([, delay]) => delay === 100)?.[0];
    expect(obsoleteWatchdog).toBeTypeOf("function");

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(signals[1].aborted).toBe(false);
    expect(listener.status).toBe("connected");

    obsoleteWatchdog();
    await vi.advanceTimersByTimeAsync(0);

    expect(signals[1].aborted).toBe(false);
    expect(listener.status).toBe("connected");
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    listener.disconnect();
    timeoutSpy.mockRestore();
    vi.useRealTimers();
  });

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

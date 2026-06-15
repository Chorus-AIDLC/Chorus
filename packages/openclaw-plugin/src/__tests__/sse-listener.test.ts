import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChorusSseListener } from "../sse-listener.js";

// The version the listener self-reports comes from the plugin's own
// package.json (one level above src/) — assert against that same source rather
// than a hardcoded literal, so a version bump doesn't break the test.
const PLUGIN_VERSION = (
  JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8"),
  ) as { version: string }
).version;

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** Build a Response whose body streams the given UTF-8 chunks then closes. */
function streamingResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ChorusSseListener", () => {
  it("parses a data frame and forwards the JSON event to onEvent", async () => {
    const events: unknown[] = [];
    const logger = makeLogger();
    const payload = JSON.stringify({ type: "new_notification", notificationUuid: "n1" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamingResponse([`data: ${payload}\n\n`])),
    );

    const listener = new ChorusSseListener({
      chorusUrl: "https://c.example.com",
      apiKey: "cho_x",
      logger,
      onEvent: (e) => events.push(e),
      onReconnect: async () => {},
    });
    await listener.connect();
    // allow the stream consumer microtasks to run
    await new Promise((r) => setTimeout(r, 5));

    expect(events).toEqual([{ type: "new_notification", notificationUuid: "n1" }]);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("SSE connection established"));
    listener.disconnect();
  });

  it("handles frames split across chunk boundaries and ignores heartbeat comments", async () => {
    const events: unknown[] = [];
    const payload = JSON.stringify({ type: "new_notification", notificationUuid: "split" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        streamingResponse([": keep-alive\n\n", `data: ${payload.slice(0, 10)}`, `${payload.slice(10)}\n\n`]),
      ),
    );

    const listener = new ChorusSseListener({
      chorusUrl: "https://c.example.com",
      apiKey: "cho_x",
      logger: makeLogger(),
      onEvent: (e) => events.push(e),
      onReconnect: async () => {},
    });
    await listener.connect();
    await new Promise((r) => setTimeout(r, 5));

    expect(events).toEqual([{ type: "new_notification", notificationUuid: "split" }]);
    listener.disconnect();
  });

  it("warns on a malformed data frame but does not throw", async () => {
    const logger = makeLogger();
    vi.stubGlobal("fetch", vi.fn(async () => streamingResponse(["data: {not json\n\n"])));

    const listener = new ChorusSseListener({
      chorusUrl: "https://c.example.com",
      apiKey: "cho_x",
      logger,
      onEvent: () => {},
      onReconnect: async () => {},
    });
    await listener.connect();
    await new Promise((r) => setTimeout(r, 5));

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("JSON parse error"));
    listener.disconnect();
  });

  it("schedules a reconnect with backoff when the endpoint returns non-200", async () => {
    vi.useFakeTimers();
    const logger = makeLogger();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 }) as Response));

    const listener = new ChorusSseListener({
      chorusUrl: "https://c.example.com",
      apiKey: "cho_x",
      logger,
      onEvent: () => {},
      onReconnect: async () => {},
    });
    await listener.connect();

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("returned 503"));
    expect(listener.status).toBe("reconnecting");
    listener.disconnect();
    expect(listener.status).toBe("disconnected");
  });

  it("sends the Bearer token and Accept header on connect", async () => {
    const fetchSpy = vi.fn(async () => streamingResponse([]));
    vi.stubGlobal("fetch", fetchSpy);

    const listener = new ChorusSseListener({
      chorusUrl: "https://c.example.com/",
      apiKey: "cho_secret",
      logger: makeLogger(),
      onEvent: () => {},
      onReconnect: async () => {},
    });
    await listener.connect();

    const [url, init] = fetchSpy.mock.calls[0];
    // The notification path is unchanged; self-report params now follow it.
    expect(String(url)).toMatch(/^https:\/\/c\.example\.com\/api\/events\/notifications\?/);
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer cho_secret",
      Accept: "text/event-stream",
    });
    listener.disconnect();
  });

  it("appends clientType=openclaw + version + host + startedAt to the SSE URL", async () => {
    const fetchSpy = vi.fn(async () => streamingResponse([]));
    vi.stubGlobal("fetch", fetchSpy);

    const listener = new ChorusSseListener({
      chorusUrl: "https://c.example.com/",
      apiKey: "cho_secret",
      logger: makeLogger(),
      onEvent: () => {},
      onReconnect: async () => {},
    });
    await listener.connect();

    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe("https://c.example.com/api/events/notifications");
    expect(url.searchParams.get("clientType")).toBe("openclaw");
    // Version is the plugin's real package version, not a hardcoded literal.
    expect(url.searchParams.get("clientVersion")).toBe(PLUGIN_VERSION);
    expect(url.searchParams.get("host")).toBe(hostname());
    const startedAt = url.searchParams.get("startedAt");
    expect(startedAt).toBeTruthy();
    expect(Number.isNaN(Date.parse(startedAt as string))).toBe(false);
    expect(new Date(startedAt as string).toISOString()).toBe(startedAt);

    listener.disconnect();
  });

  it("re-sends the same self-report params on reconnect", async () => {
    vi.useFakeTimers();
    let call = 0;
    const fetchSpy = vi.fn(async () => {
      call++;
      if (call === 1) return { ok: false, status: 503 } as Response;
      return streamingResponse([]);
    });
    vi.stubGlobal("fetch", fetchSpy);

    const listener = new ChorusSseListener({
      chorusUrl: "https://c.example.com/",
      apiKey: "cho_secret",
      logger: makeLogger(),
      onEvent: () => {},
      onReconnect: async () => {},
    });
    await listener.connect(); // first attempt fails → reconnecting
    await vi.advanceTimersByTimeAsync(1000); // backoff fires the reconnect

    expect(call).toBe(2);
    // The reconnect re-sends the byte-identical URL (params included).
    expect(String(fetchSpy.mock.calls[1][0])).toBe(String(fetchSpy.mock.calls[0][0]));
    const u = new URL(String(fetchSpy.mock.calls[1][0]));
    expect(u.searchParams.get("clientType")).toBe("openclaw");
    expect(u.searchParams.get("clientVersion")).toBe(PLUGIN_VERSION);

    listener.disconnect();
  });
});

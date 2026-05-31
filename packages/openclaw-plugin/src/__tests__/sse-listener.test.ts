import { describe, it, expect, vi, afterEach } from "vitest";
import { ChorusSseListener } from "../sse-listener.js";

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
    expect(url).toBe("https://c.example.com/api/events/notifications");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer cho_secret",
      Accept: "text/event-stream",
    });
    listener.disconnect();
  });
});

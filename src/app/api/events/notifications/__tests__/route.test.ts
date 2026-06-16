import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ===== Mocks =====
const mockGetAuthContext = vi.fn();

const mockEventBus = vi.hoisted(() => ({
  on: vi.fn(),
  off: vi.fn(),
  emit: vi.fn(),
}));

const mockParseSelfReport = vi.fn();
const mockRegisterConnection = vi.fn();
const mockTouchConnection = vi.fn();
const mockMarkDisconnected = vi.fn();

vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
}));

vi.mock("@/lib/event-bus", () => ({
  eventBus: mockEventBus,
}));

vi.mock("@/services/daemon-connection.service", () => ({
  parseSelfReport: (...args: unknown[]) => mockParseSelfReport(...args),
  registerConnection: (...args: unknown[]) => mockRegisterConnection(...args),
  touchConnection: (...args: unknown[]) => mockTouchConnection(...args),
  markDisconnected: (...args: unknown[]) => mockMarkDisconnected(...args),
}));

import { GET } from "@/app/api/events/notifications/route";

// ===== Helpers =====
const companyUuid = "company-0000-0000-0000-000000000001";
const actorUuid = "agent-0000-0000-0000-000000000001";
const connectionUuid = "conn-0000-0000-0000-000000000001";
// registerConnection now returns a {uuid, connectedAt} handle (the connectedAt
// is a generation fence); touch/markDisconnected receive the whole handle.
const connHandle = { uuid: connectionUuid, connectedAt: new Date("2026-06-15T03:00:00.000Z") };

const agentAuth = { type: "agent", companyUuid, actorUuid, permissions: [] };

function makeRequest(query = "", signal?: AbortSignal): NextRequest {
  const url = `http://localhost:3000/api/events/notifications${query ? `?${query}` : ""}`;
  return new NextRequest(new URL(url), signal ? { signal } : undefined);
}

async function startStream(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // reader cancelled / stream closed
    }
  })();
  await flush();
  return { chunks, reader };
}

/**
 * Drain the microtask queue so enqueued stream chunks are read by the pump.
 * Microtask-only (no setTimeout) so it works under vi.useFakeTimers().
 */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue(agentAuth);
  mockParseSelfReport.mockReturnValue({ clientType: "openclaw", host: "h" });
  mockRegisterConnection.mockResolvedValue(connHandle);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/events/notifications (notification SSE)", () => {
  it("returns 401 without registering when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue(null);
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(mockRegisterConnection).not.toHaveBeenCalled();
    expect(mockParseSelfReport).not.toHaveBeenCalled();
  });

  it("registers on connect after auth using the authenticated company/actor (not query params)", async () => {
    const res = await GET(makeRequest("clientType=openclaw&host=h"));
    await startStream(res);

    expect(mockRegisterConnection).toHaveBeenCalledTimes(1);
    expect(mockRegisterConnection).toHaveBeenCalledWith(
      companyUuid,
      actorUuid,
      { clientType: "openclaw", host: "h" },
    );
    expect(mockParseSelfReport).toHaveBeenCalledTimes(1);
    expect(mockParseSelfReport.mock.calls[0][0]).toBeInstanceOf(URLSearchParams);
  });

  it("emits a connection_registered data event carrying the connectionUuid for a daemon connection", async () => {
    const res = await GET(makeRequest("clientType=openclaw"));
    const { chunks } = await startStream(res);

    const joined = chunks.join("");
    expect(joined).toContain(": connected");
    // The daemon parses this to learn which DaemonConnection it registered as
    // (needed to attribute POST /api/daemon/execution-state snapshots).
    expect(joined).toContain('"type":"connection_registered"');
    expect(joined).toContain(`"connectionUuid":"${connectionUuid}"`);
  });

  it("subscribes to the per-user notification channel and delivers events", async () => {
    const res = await GET(makeRequest("clientType=openclaw"));
    const { chunks } = await startStream(res);

    const onCall = mockEventBus.on.mock.calls.find((c) =>
      String(c[0]).startsWith("notification:"),
    );
    expect(onCall).toBeDefined();
    expect(onCall![0]).toBe(`notification:agent:${actorUuid}`);

    const handler = onCall![1] as (e: Record<string, unknown>) => void;
    const before = chunks.length;
    handler({ type: "mention", id: 1 });
    await flush();
    expect(chunks.length).toBe(before + 1);
    expect(chunks[chunks.length - 1]).toContain("mention");
  });

  it("touches the connection on each heartbeat tick (daemon clientType)", async () => {
    vi.useFakeTimers();
    const res = await GET(makeRequest("clientType=openclaw"));
    await startStream(res);

    expect(mockTouchConnection).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockTouchConnection).toHaveBeenCalledTimes(1);
    expect(mockTouchConnection).toHaveBeenCalledWith(companyUuid, connHandle);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockTouchConnection).toHaveBeenCalledTimes(2);
  });

  it("marks disconnected on abort and unsubscribes the handler", async () => {
    const ac = new AbortController();
    const res = await GET(makeRequest("clientType=openclaw", ac.signal));
    await startStream(res);

    expect(mockMarkDisconnected).not.toHaveBeenCalled();
    ac.abort();
    await Promise.resolve();

    expect(mockMarkDisconnected).toHaveBeenCalledTimes(1);
    expect(mockMarkDisconnected).toHaveBeenCalledWith(companyUuid, connHandle);
    expect(mockEventBus.off).toHaveBeenCalledWith(
      `notification:agent:${actorUuid}`,
      expect.any(Function),
    );
  });

  describe("no-clientType / browser connection", () => {
    beforeEach(() => {
      mockParseSelfReport.mockReturnValue({ clientType: "", host: null });
      mockRegisterConnection.mockResolvedValue(null);
    });

    it("still streams (connected + heartbeat) but writes no registry row", async () => {
      vi.useFakeTimers();
      const ac = new AbortController();
      const res = await GET(makeRequest("", ac.signal));
      const { chunks } = await startStream(res);

      expect(mockRegisterConnection).toHaveBeenCalledTimes(1);
      expect(chunks.join("")).toContain(": connected");
      // No registry row (conn === null) → no connection_registered event emitted.
      expect(chunks.join("")).not.toContain("connection_registered");

      await vi.advanceTimersByTimeAsync(30_000);
      expect(chunks.join("")).toContain(": heartbeat");
      expect(mockTouchConnection).not.toHaveBeenCalled();

      ac.abort();
      await Promise.resolve();
      expect(mockMarkDisconnected).not.toHaveBeenCalled();
    });
  });
});

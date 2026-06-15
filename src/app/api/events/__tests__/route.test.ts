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

import { GET } from "@/app/api/events/route";

// ===== Helpers =====
const companyUuid = "company-0000-0000-0000-000000000001";
const actorUuid = "agent-0000-0000-0000-000000000001";
const connectionUuid = "conn-0000-0000-0000-000000000001";
// registerConnection now returns a {uuid, connectedAt} handle (the connectedAt
// is a generation fence); touch/markDisconnected receive the whole handle.
const connHandle = { uuid: connectionUuid, connectedAt: new Date("2026-06-15T03:00:00.000Z") };

const agentAuth = { type: "agent", companyUuid, actorUuid, permissions: [] };

function makeRequest(query = "", signal?: AbortSignal): NextRequest {
  const url = `http://localhost:3000/api/events${query ? `?${query}` : ""}`;
  return new NextRequest(new URL(url), signal ? { signal } : undefined);
}

/**
 * Drive the SSE response: start consuming the stream so its `start(controller)`
 * callback runs synchronously, and collect every chunk decoded to text.
 */
async function startStream(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  const pump = (async () => {
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
  // Let the start() microtask + first enqueue settle.
  await flush();
  return { chunks, pump, reader };
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
  // Default: behave as a daemon connection.
  mockParseSelfReport.mockReturnValue({ clientType: "claude_code", host: "h" });
  mockRegisterConnection.mockResolvedValue(connHandle);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/events (change events SSE)", () => {
  it("returns 401 without registering when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue(null);
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(mockRegisterConnection).not.toHaveBeenCalled();
    expect(mockParseSelfReport).not.toHaveBeenCalled();
  });

  it("registers on connect after auth using the authenticated company/actor (not query params)", async () => {
    const res = await GET(makeRequest("clientType=claude_code&host=h"));
    await startStream(res);

    expect(mockRegisterConnection).toHaveBeenCalledTimes(1);
    expect(mockRegisterConnection).toHaveBeenCalledWith(
      companyUuid,
      actorUuid,
      { clientType: "claude_code", host: "h" },
    );
    // self-report is read from the request URL search params, after auth.
    expect(mockParseSelfReport).toHaveBeenCalledTimes(1);
    expect(mockParseSelfReport.mock.calls[0][0]).toBeInstanceOf(URLSearchParams);
  });

  it("touches the connection on each heartbeat tick (daemon clientType)", async () => {
    vi.useFakeTimers();
    const res = await GET(makeRequest("clientType=claude_code"));
    await startStream(res);

    expect(mockTouchConnection).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockTouchConnection).toHaveBeenCalledTimes(1);
    expect(mockTouchConnection).toHaveBeenCalledWith(companyUuid, connHandle);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockTouchConnection).toHaveBeenCalledTimes(2);
  });

  it("marks disconnected on abort (daemon clientType)", async () => {
    const ac = new AbortController();
    const res = await GET(makeRequest("clientType=claude_code", ac.signal));
    await startStream(res);

    expect(mockMarkDisconnected).not.toHaveBeenCalled();
    ac.abort();
    await Promise.resolve();

    expect(mockMarkDisconnected).toHaveBeenCalledTimes(1);
    expect(mockMarkDisconnected).toHaveBeenCalledWith(companyUuid, connHandle);
  });

  it("preserves projectUuid filtering: cross-project change events are dropped", async () => {
    const res = await GET(makeRequest("projectUuid=proj-1&clientType=claude_code"));
    const { chunks } = await startStream(res);

    // The route subscribed a change handler — grab it and exercise the filter.
    const changeCall = mockEventBus.on.mock.calls.find((c) => c[0] === "change");
    expect(changeCall).toBeDefined();
    const handler = changeCall![1] as (e: Record<string, unknown>) => void;

    const before = chunks.length;
    // Wrong project → dropped.
    handler({ companyUuid, projectUuid: "other", type: "x" });
    await flush();
    expect(chunks.length).toBe(before);
    // Matching project → delivered.
    handler({ companyUuid, projectUuid: "proj-1", type: "x" });
    await flush();
    expect(chunks.length).toBe(before + 1);
    expect(chunks[chunks.length - 1]).toContain("proj-1");
  });

  it("drops change events from a different company (multi-tenancy)", async () => {
    const res = await GET(makeRequest("clientType=claude_code"));
    const { chunks } = await startStream(res);
    const handler = mockEventBus.on.mock.calls.find((c) => c[0] === "change")![1] as (
      e: Record<string, unknown>,
    ) => void;

    const before = chunks.length;
    handler({ companyUuid: "other-company", type: "x" });
    await flush();
    expect(chunks.length).toBe(before);
  });

  describe("no-clientType / browser connection", () => {
    beforeEach(() => {
      mockParseSelfReport.mockReturnValue({ clientType: "", host: null });
      // registerConnection returns null for a non-daemon clientType.
      mockRegisterConnection.mockResolvedValue(null);
    });

    it("still streams (connected + heartbeat) but writes no registry row", async () => {
      vi.useFakeTimers();
      const ac = new AbortController();
      const res = await GET(makeRequest("", ac.signal));
      const { chunks } = await startStream(res);

      // registerConnection was still consulted (returned null), but no lifecycle fired.
      expect(mockRegisterConnection).toHaveBeenCalledTimes(1);
      expect(chunks.join("")).toContain(": connected");

      await vi.advanceTimersByTimeAsync(30_000);
      // Heartbeat still flows to the client...
      expect(chunks.join("")).toContain(": heartbeat");
      // ...but touch is skipped because connUuid is null.
      expect(mockTouchConnection).not.toHaveBeenCalled();

      ac.abort();
      await Promise.resolve();
      expect(mockMarkDisconnected).not.toHaveBeenCalled();
    });
  });

  it("does not break the stream when registerConnection rejects (it cannot — it swallows)", async () => {
    // The service never throws, but assert the route does not await-throw regardless.
    mockRegisterConnection.mockResolvedValue(null);
    const res = await GET(makeRequest("clientType=claude_code"));
    const { chunks } = await startStream(res);
    expect(res.status).toBe(200);
    expect(chunks.join("")).toContain(": connected");
  });
});

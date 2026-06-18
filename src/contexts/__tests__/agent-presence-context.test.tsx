// @vitest-environment jsdom
//
// Unit tests for the shell-level AgentPresenceProvider: the count, the SSE
// execution merge, and (critically) the error-state contract — a failed poll
// sets status:"error" and MUST NOT zero the online count.
//
// Test seams (no production-code seam required):
//   - `authFetch` is mocked so we drive the connection poll + executions fetch.
//   - `globalThis.EventSource` is stubbed (same pattern as the realtime-context
//     test) so the test drives `onmessage` / reconnect directly.

import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render, renderHook } from "@testing-library/react";

import {
  AgentPresenceProvider,
  useAgentPresence,
  computeOnlineCount,
  groupExecutionsByConnection,
  mergeExecutionEvent,
  type ExecutionsByConnection,
} from "@/contexts/agent-presence-context";
import type { ConnectionView, ExecutionView } from "@/components/agent-presence";

// authFetch is the provider's only network dependency; mock it.
const authFetch = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authFetch: (url: string, opts?: RequestInit) => authFetch(url, opts),
}));
vi.mock("@/lib/logger-client", () => ({
  clientLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

// ---- EventSource stub (mirrors realtime-context.test.tsx) ----
interface CapturedEventSource {
  url: string;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: (() => void) | null;
  readyState: number;
  close: () => void;
}
let lastEventSource: CapturedEventSource | null = null;
let eventSourceConstructions = 0;
class MockEventSource implements CapturedEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  url: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = MockEventSource.OPEN;
  constructor(url: string) {
    this.url = url;
    lastEventSource = this;
    eventSourceConstructions += 1;
  }
  close() {
    this.readyState = MockEventSource.CLOSED;
  }
}

// ---- fixtures ----
function conn(uuid: string, effectiveStatus: "online" | "offline"): ConnectionView {
  return {
    uuid,
    agentUuid: `agent-${uuid}`,
    agentName: `Agent ${uuid}`,
    clientType: "claude_code",
    clientVersion: null,
    host: "host",
    startedAt: null,
    status: effectiveStatus,
    effectiveStatus,
    connectedAt: "2026-06-18T00:00:00.000Z",
    lastSeenAt: "2026-06-18T00:00:00.000Z",
    disconnectedAt: null,
  };
}

function exec(
  uuid: string,
  connectionUuid: string,
  status: string,
): ExecutionView {
  return {
    uuid,
    agentUuid: `agent-${connectionUuid}`,
    connectionUuid,
    entityType: "task",
    entityUuid: `task-${uuid}`,
    rootIdeaUuid: null,
    status,
    interruptedReason: null,
    startedAt: null,
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:00:00.000Z",
    entityTitle: `Task ${uuid}`,
    projectUuid: "project-1",
    rootIdeaTitle: null,
  };
}

// Build a fake Response for authFetch.
function okJson(data: unknown) {
  return { ok: true, json: async () => ({ success: true, data }) };
}
function failResponse() {
  return { ok: false, json: async () => ({ success: false }) };
}

// Route authFetch by URL so connection poll vs executions fetch are independent.
function routeAuthFetch(handlers: {
  connections?: () => unknown;
  executions?: () => unknown;
}) {
  authFetch.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/agent-connections")) {
      return handlers.connections ? handlers.connections() : okJson({ connections: [] });
    }
    if (url.startsWith("/api/daemon/executions")) {
      return handlers.executions ? handlers.executions() : okJson({ executions: [] });
    }
    throw new Error(`unexpected url ${url}`);
  });
}

function dispatchSse(payload: Record<string, unknown>) {
  if (!lastEventSource?.onmessage) throw new Error("EventSource onmessage not bound");
  lastEventSource.onmessage({ data: JSON.stringify(payload) } as MessageEvent);
}

beforeEach(() => {
  lastEventSource = null;
  eventSourceConstructions = 0;
  authFetch.mockReset();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).EventSource = MockEventSource;
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).EventSource;
  vi.restoreAllMocks();
});

// =====================================================================
// Pure helpers
// =====================================================================

describe("computeOnlineCount", () => {
  it("counts only effectiveStatus === 'online' connections", () => {
    expect(
      computeOnlineCount([conn("a", "online"), conn("b", "offline"), conn("c", "online")]),
    ).toBe(2);
  });
  it("is 0 for an empty list", () => {
    expect(computeOnlineCount([])).toBe(0);
  });
});

describe("groupExecutionsByConnection", () => {
  it("groups a flat list by connectionUuid", () => {
    const map = groupExecutionsByConnection([
      exec("1", "conn-a", "running"),
      exec("2", "conn-a", "queued"),
      exec("3", "conn-b", "running"),
    ]);
    expect(map["conn-a"]).toHaveLength(2);
    expect(map["conn-b"]).toHaveLength(1);
  });
  it("returns an empty map for no executions", () => {
    expect(groupExecutionsByConnection([])).toEqual({});
  });
});

describe("mergeExecutionEvent", () => {
  it("replaces a connection's slice wholesale and returns a new object", () => {
    const prev: ExecutionsByConnection = { "conn-a": [exec("old", "conn-a", "running")] };
    const next = mergeExecutionEvent(prev, {
      connectionUuid: "conn-a",
      executions: [exec("new1", "conn-a", "running"), exec("new2", "conn-a", "queued")],
    });
    expect(next).not.toBe(prev); // new reference for React
    expect(next["conn-a"]).toHaveLength(2);
    expect(next["conn-a"][0].uuid).toBe("new1");
  });
  it("merges a new connection without disturbing others", () => {
    const prev: ExecutionsByConnection = { "conn-a": [exec("a", "conn-a", "running")] };
    const next = mergeExecutionEvent(prev, {
      connectionUuid: "conn-b",
      executions: [exec("b", "conn-b", "running")],
    });
    expect(Object.keys(next).sort()).toEqual(["conn-a", "conn-b"]);
  });
  it("clears a connection's key when the event carries an empty set", () => {
    const prev: ExecutionsByConnection = {
      "conn-a": [exec("a", "conn-a", "running")],
      "conn-b": [exec("b", "conn-b", "running")],
    };
    const next = mergeExecutionEvent(prev, { connectionUuid: "conn-a", executions: [] });
    expect(next["conn-a"]).toBeUndefined();
    expect(next["conn-b"]).toHaveLength(1);
  });
});

// =====================================================================
// Provider integration
// =====================================================================

// Capture the latest context value off a render.
function renderProvider() {
  return renderHook(() => useAgentPresence(), {
    wrapper: ({ children }) => <AgentPresenceProvider>{children}</AgentPresenceProvider>,
  });
}

describe("useAgentPresence outside the provider", () => {
  it("throws (wiring bug should not be silent)", () => {
    expect(() => renderHook(() => useAgentPresence())).toThrow(
      /must be used within an AgentPresenceProvider/,
    );
  });
});

describe("AgentPresenceProvider — first paint + count", () => {
  it("reaches status 'ok' with the online count and first-paint executions", async () => {
    routeAuthFetch({
      connections: () => okJson({ connections: [conn("c1", "online"), conn("c2", "offline")] }),
      executions: () => okJson({ executions: [exec("e1", "c1", "running")] }),
    });

    const { result } = renderProvider();
    // Let the mount effects (poll + executions fetch) settle.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.status).toBe("ok");
    expect(result.current.onlineCount).toBe(1);
    expect(result.current.connections).toHaveLength(2);
    expect(result.current.executionsByConnection["c1"]).toHaveLength(1);
    // One company-wide EventSource, no projectUuid.
    expect(lastEventSource?.url).toBe("/api/events");
  });
});

describe("AgentPresenceProvider — error never zeros the count", () => {
  it("does not report a misleading 0 online when a later poll fails", async () => {
    vi.useFakeTimers();
    let connCall = 0;
    authFetch.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/agent-connections")) {
        connCall += 1;
        if (connCall === 1) {
          return okJson({ connections: [conn("c1", "online"), conn("c2", "online")] });
        }
        return failResponse();
      }
      return okJson({ executions: [] });
    });

    const { result } = renderProvider();
    // Flush the mount poll's microtasks.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status).toBe("ok");
    expect(result.current.onlineCount).toBe(2);

    // Advance to the next 15s poll tick (which fails).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(result.current.status).toBe("error");
    // CRITICAL: the count is NOT zeroed by the failure.
    expect(result.current.onlineCount).toBe(2);
    expect(result.current.connections).toHaveLength(2);

    vi.useRealTimers();
  });

  it("sets status 'error' when authFetch rejects (network error)", async () => {
    vi.useFakeTimers();
    authFetch.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/agent-connections")) {
        throw new Error("network down");
      }
      return okJson({ executions: [] });
    });
    const { result } = renderProvider();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status).toBe("error");
    expect(result.current.onlineCount).toBe(0); // genuinely no prior data
    vi.useRealTimers();
  });
});

describe("AgentPresenceProvider — SSE execution merge", () => {
  it("merges an execution event into executionsByConnection by connectionUuid", async () => {
    routeAuthFetch({
      connections: () => okJson({ connections: [conn("c1", "online")] }),
      executions: () => okJson({ executions: [] }),
    });
    const { result } = renderProvider();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      dispatchSse({
        type: "execution",
        companyUuid: "company-1",
        connectionUuid: "c1",
        executions: [exec("e1", "c1", "running"), exec("e2", "c1", "queued")],
      });
    });

    expect(result.current.executionsByConnection["c1"]).toHaveLength(2);
  });

  it("ignores non-execution SSE events", async () => {
    routeAuthFetch({});
    const { result } = renderProvider();
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      dispatchSse({ type: "presence", companyUuid: "company-1", entityType: "task" });
    });
    expect(result.current.executionsByConnection).toEqual({});
  });

  it("ignores non-JSON heartbeat messages without throwing", async () => {
    routeAuthFetch({});
    renderProvider();
    await act(async () => {
      await Promise.resolve();
    });
    expect(() =>
      act(() => {
        if (!lastEventSource?.onmessage) throw new Error("no onmessage");
        lastEventSource.onmessage({ data: ":heartbeat" } as MessageEvent);
      }),
    ).not.toThrow();
  });
});

describe("AgentPresenceProvider — periodic executions poll (self-heal)", () => {
  it("re-fetches the executions aggregate on the 15s tick, picking up work that started after first paint", async () => {
    vi.useFakeTimers();
    let execCall = 0;
    authFetch.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/agent-connections")) {
        return okJson({ connections: [conn("c1", "online")] });
      }
      if (url.startsWith("/api/daemon/executions")) {
        execCall += 1;
        // First paint: nothing running. After the next poll: a task is running.
        return execCall === 1
          ? okJson({ executions: [] })
          : okJson({ executions: [exec("e1", "c1", "running")] });
      }
      throw new Error(`unexpected ${url}`);
    });

    const { result } = renderProvider();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // First paint: no executions yet.
    expect(result.current.executionsByConnection["c1"]).toBeUndefined();
    expect(result.current.executionsLoaded).toBe(true);

    // Advance to the next 15s poll — the aggregate now carries a running row,
    // even though NO SSE event and NO visibility-reconnect fired.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(result.current.executionsByConnection["c1"]).toHaveLength(1);
    vi.useRealTimers();
  });
});

describe("AgentPresenceProvider — poll vs SSE race guard", () => {
  it("a slow aggregate poll does not clobber a slice an SSE event freshened mid-flight", async () => {
    let resolveExec: ((v: unknown) => void) | null = null;
    authFetch.mockImplementation((url: string) => {
      if (url.startsWith("/api/agent-connections")) {
        return Promise.resolve(okJson({ connections: [conn("c1", "online")] }));
      }
      if (url.startsWith("/api/daemon/executions")) {
        // Hang the aggregate so an SSE event can land while it is in flight.
        return new Promise((resolve) => {
          resolveExec = resolve;
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    const { result } = renderProvider();
    await act(async () => {
      await Promise.resolve();
    });

    // An execution event for c1 arrives WHILE the aggregate request is pending.
    act(() => {
      dispatchSse({
        type: "execution",
        companyUuid: "company-1",
        connectionUuid: "c1",
        executions: [exec("live", "c1", "running")],
      });
    });
    expect(result.current.executionsByConnection["c1"]).toHaveLength(1);

    // The stale aggregate now resolves with an EMPTY set for c1. The fresher SSE
    // slice must survive (last-WRITE wins, not last-RESPONSE).
    await act(async () => {
      resolveExec?.(okJson({ executions: [] }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.executionsByConnection["c1"]).toHaveLength(1);
    expect(result.current.executionsByConnection["c1"][0].uuid).toBe("live");
  });
});

describe("AgentPresenceProvider — reconnect re-fetches the aggregate", () => {
  it("reconnects a CONNECTING (auto-reconnecting) stream on visibility, not just a CLOSED one", async () => {
    let execCall = 0;
    authFetch.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/agent-connections")) {
        return okJson({ connections: [conn("c1", "online")] });
      }
      if (url.startsWith("/api/daemon/executions")) {
        execCall += 1;
        return okJson({ executions: [] });
      }
      throw new Error(`unexpected ${url}`);
    });

    renderProvider();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const constructionsAfterMount = eventSourceConstructions;
    const execCallsAfterMount = execCall;

    // Simulate the browser auto-reconnect limbo: the stream errored and is
    // CONNECTING (readyState 0), NOT CLOSED. The old `=== CLOSED` guard would
    // have treated this as healthy and never recovered.
    act(() => {
      if (lastEventSource) lastEventSource.readyState = MockEventSource.CONNECTING;
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(eventSourceConstructions).toBe(constructionsAfterMount + 1);
    expect(execCall).toBe(execCallsAfterMount + 1);
  });
});

describe("AgentPresenceProvider — reconnect re-fetches the aggregate (closed)", () => {
  it("reconnects EventSource and re-fetches executions on visibilitychange when the stream was lost", async () => {
    let execCall = 0;
    authFetch.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/agent-connections")) {
        return okJson({ connections: [conn("c1", "online")] });
      }
      if (url.startsWith("/api/daemon/executions")) {
        execCall += 1;
        return okJson({ executions: [] });
      }
      throw new Error(`unexpected ${url}`);
    });

    renderProvider();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const constructionsAfterMount = eventSourceConstructions;
    const execCallsAfterMount = execCall;

    // Simulate the tab being backgrounded then the stream dropping.
    act(() => {
      lastEventSource?.close();
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(eventSourceConstructions).toBe(constructionsAfterMount + 1);
    expect(execCall).toBe(execCallsAfterMount + 1);
  });
});

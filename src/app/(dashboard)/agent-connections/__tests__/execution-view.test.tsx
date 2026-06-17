// @vitest-environment jsdom
//
// Execution-view integration test for the Agent Connections detail pane (T4).
//
// Covers the spec requirement "The Agent Connections detail pane SHALL display
// the connection's running and queued tasks" end to end on the client side:
//   - first paint renders the running + queued lists from the read API
//     (GET /api/daemon/execution-state) BEFORE any SSE event,
//   - running rows show a live elapsed indicator + root-idea session + task link,
//     queued rows show no timer,
//   - a localized empty state renders when there is neither, and
//   - an `execution` SSE event (driven through a REAL RealtimeProvider + a mock
//     EventSource) updates the pane live — a task starting/finishing, and the
//     offline → empty active set.
//
// Test seam: the page calls authFetch (mocked, routed by URL) for both the
// connection list and the per-connection execution read; SSE input is a mock
// EventSource the test drives via onmessage, exactly like the realtime-context
// test. No production seam is added.

import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";

// next-intl: resolve real en strings so a missing key surfaces as its dotted
// path and fails the assertion (mirrors the sibling page test).
vi.mock("next-intl", async () => {
  const en = (await import("../../../../../messages/en.json")).default as Record<
    string,
    unknown
  >;
  function resolve(namespace: string, key: string): string {
    const fullKey = namespace ? `${namespace}.${key}` : key;
    let node: unknown = en;
    for (const p of fullKey.split(".")) {
      if (node && typeof node === "object" && p in (node as Record<string, unknown>)) {
        node = (node as Record<string, unknown>)[p];
      } else {
        return fullKey;
      }
    }
    return typeof node === "string" ? node : fullKey;
  }
  return {
    useTranslations:
      (namespace = "") =>
      (key: string, params?: Record<string, string | number>) => {
        let s = resolve(namespace, key);
        if (params) {
          for (const [k, v] of Object.entries(params)) {
            s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
          }
        }
        return s;
      },
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const mockAuthFetch = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

vi.mock("@/lib/logger-client", () => ({
  clientLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import AgentConnectionsPage from "@/app/(dashboard)/agent-connections/page";

// ===== EventSource stub (drives SSE) =====
interface CapturedEventSource {
  url: string;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: (() => void) | null;
  readyState: number;
  close: () => void;
}
let lastEventSource: CapturedEventSource | null = null;
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
  }
  close() {
    this.readyState = MockEventSource.CLOSED;
  }
}

// ===== Fixtures =====
const NOW = "2026-06-16T12:00:00.000Z";
const CONN_UUID = "conn-1";

const connection = {
  uuid: CONN_UUID,
  agentUuid: "agent-1",
  agentName: "Alpha",
  clientType: "claude_code",
  clientVersion: "0.11.0",
  host: "host-1",
  startedAt: NOW,
  status: "online",
  effectiveStatus: "online",
  connectedAt: NOW,
  lastSeenAt: NOW,
  disconnectedAt: null,
};

function execView(overrides: Record<string, unknown> & { uuid: string }) {
  return {
    agentUuid: "agent-1",
    connectionUuid: CONN_UUID,
    entityType: "task",
    entityUuid: "task-" + overrides.uuid,
    rootIdeaUuid: null,
    status: "running",
    startedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    entityTitle: "Task " + overrides.uuid,
    projectUuid: "proj-1",
    rootIdeaTitle: null,
    ...overrides,
  };
}

// Route authFetch by URL: connection list vs. per-connection execution read.
function routeFetch(executions: unknown[]) {
  mockAuthFetch.mockImplementation((url: string) => {
    if (typeof url === "string" && url.startsWith("/api/daemon/execution-state")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, data: { executions } }),
      });
    }
    // Default: the connection list.
    return Promise.resolve({
      ok: true,
      json: async () => ({ success: true, data: { connections: [connection] } }),
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  lastEventSource = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).EventSource = MockEventSource;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-06-16T12:05:00.000Z")); // 5 min after startedAt
});

afterEach(() => {
  vi.useRealTimers();
});

async function renderPage() {
  // The page provides its OWN RealtimeProvider (the BLOCKER fix), so render it
  // directly — no test-supplied wrapper. This verifies the real shipped wiring:
  // a global page that mounts its own provider and therefore receives live
  // execution events. (A test-supplied provider would mask a missing one.)
  const utils = render(<AgentConnectionsPage />);
  await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
  return utils;
}

// Push an execution SSE event through the live RealtimeProvider's EventSource.
function pushExecutionEvent(executions: unknown[]) {
  act(() => {
    lastEventSource?.onmessage?.({
      data: JSON.stringify({
        type: "execution",
        companyUuid: "company-1",
        connectionUuid: CONN_UUID,
        executions,
      }),
    } as MessageEvent);
  });
}

describe("Agent Connections execution view", () => {
  it("first paint renders running + queued lists from the read API (before any SSE event)", async () => {
    routeFetch([
      execView({
        uuid: "run",
        status: "running",
        startedAt: NOW, // 5 min ago → 00:05:00
        rootIdeaTitle: "Ship the daemon",
        rootIdeaUuid: "idea-1",
      }),
      execView({ uuid: "q1", status: "queued", startedAt: null }),
    ]);
    await renderPage();

    // Running task title + its root-idea session + a live elapsed indicator.
    await waitFor(() => expect(screen.getAllByText("Task run").length).toBeGreaterThan(0));
    expect(screen.getAllByText(/Ship the daemon/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("00:05:00").length).toBeGreaterThan(0);

    // Queued task is listed without an elapsed timer; the "Waiting" hint shows.
    expect(screen.getAllByText("Task q1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Waiting").length).toBeGreaterThan(0);

    // The running row links to the task detail page.
    const link = screen
      .getAllByRole("link")
      .find((a) => a.getAttribute("href") === "/projects/proj-1/tasks/task-run");
    expect(link).toBeTruthy();

    // The old "coming soon" placeholder is gone.
    expect(screen.queryByText(/Sessions & Transcript/)).toBeNull();
  });

  it("the elapsed indicator ticks every second for a running row", async () => {
    routeFetch([execView({ uuid: "run", status: "running", startedAt: NOW })]);
    await renderPage();
    await waitFor(() => expect(screen.getAllByText("00:05:00").length).toBeGreaterThan(0));
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await waitFor(() => expect(screen.getAllByText("00:05:01").length).toBeGreaterThan(0));
  });

  it("renders a localized empty state when there is no running or queued task", async () => {
    routeFetch([]);
    await renderPage();
    await waitFor(() => expect(screen.getAllByText("Nothing running").length).toBeGreaterThan(0));
  });

  it("updates live when an execution SSE event arrives (task starts)", async () => {
    routeFetch([]); // first paint: empty
    await renderPage();
    await waitFor(() => expect(screen.getAllByText("Nothing running").length).toBeGreaterThan(0));

    // A task starts → execution event → the running row appears without a refetch.
    pushExecutionEvent([
      execView({ uuid: "live", status: "running", startedAt: NOW }),
    ]);
    await waitFor(() => expect(screen.getAllByText("Task live").length).toBeGreaterThan(0));
    expect(screen.queryByText("Nothing running")).toBeNull();
  });

  it("clears the active view when the connection goes offline (empty execution event)", async () => {
    routeFetch([execView({ uuid: "run", status: "running", startedAt: NOW })]);
    await renderPage();
    await waitFor(() => expect(screen.getAllByText("Task run").length).toBeGreaterThan(0));

    // Offline reconcile publishes an empty active set → the pane clears to empty.
    pushExecutionEvent([]);
    await waitFor(() => expect(screen.getAllByText("Nothing running").length).toBeGreaterThan(0));
    expect(screen.queryByText("Task run")).toBeNull();
  });
});
